import { Worker, Queue, type Job } from 'bullmq';
import type { Connector } from '../connectors/types.js';
import { getConnector } from '../connectors/index.js';
import { fetchText } from '../connectors/http.js';
import { query } from '../core/db.js';
import { finishRun, startRun, upsertLots } from '../core/repo.js';
import { collectionJobContext, observerForCollection } from '../application/services/collection/collection-observer.js';
import { executeCollection, type CollectionExecutionDependencies } from '../application/services/collection/collection-execution.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import { processarAposColeta } from '../application/services/collection/post-collection.js';
import { DAILY_SITES, dailySite, dailyScheduleItems } from './daily-coverage.js';
import { makeRedis, type CollectJob } from './runtime.js';

export const DAILY_QUEUE = 'collect-daily-sites';
const browserSources = new Set(['caixa', 'vipleiloes', 'leiloesbrasilpublic']);

export function dailyConnector(domain: string, lookup = getConnector, enabled = async (source: string) => {
  const rows = await query<{ enabled: boolean }>('SELECT enabled FROM sources WHERE id=$1', [source]);
  return rows[0]?.enabled === true;
}): Connector {
  const site = dailySite(domain);
  const native = lookup(site.sourceId);
  return {
    def: native?.def ?? { id: site.sourceId, name: site.sourceId, method: 'html', tier: 5, siteUrl: `https://${domain}` },
    async collect(options) {
      throwIfCancelled();
      if (!await enabled(site.sourceId)) throw new Error(`Daily source disabled: ${site.sourceId}/${domain}`);
      if (site.monitorOnly) {
        const attempt = await options.observer?.start(domain);
        try {
          const response = await fetchText(`https://${domain}/`, { timeoutMs: 30000 });
          attempt?.response(response.status);
          throw new Error(`Daily monitor ${domain}: HTTP ${response.status}; no reviewed auction catalog adapter`);
        } catch (error) {
          attempt?.failure('parser');
          throw error;
        } finally { await attempt?.finish({ fetched: 0, returned: 0, skipped: 0 }); }
      }
      if (!native) throw new Error(`Daily adapter missing: ${site.sourceId}/${domain}`);
      const result = await native.collect({ ...options, tenant: domain });
      // An explicit daily job may never persist another white-label's catalog.
      const lots = result.lots.filter(lot => {
        try { return new URL(lot.lotUrl ?? '').hostname.replace(/^www\./, '') === domain; }
        catch { return false; }
      });
      return { ...result, lots, skipped: result.skipped + result.lots.length - lots.length };
    },
  };
}

export async function processDailyJob(job: Job<CollectJob>, execution: CollectionExecutionDependencies,
  signal?: AbortSignal, browserGate?: <T>(operation: () => Promise<T>) => Promise<T>) {
  const site = dailySite(String(job.data.tenant));
  // A queued catch-up can outlive a reviewed source correction. The manifest,
  // never the queued source field, selects the adapter and persisted source ID.
  if (site.sourceId !== job.data.sourceId) console.warn(`[daily] ${site.domain}: source corrected ${job.data.sourceId} -> ${site.sourceId}`);
  const limit = Math.min(site.sourceId === 'caixa' ? 15000 : 1200, job.data.limit);
  const timeoutMs = Math.min(180000, job.data.timeoutMs ?? 180000);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid daily budget');
  const adapter = dailyConnector(site.domain, execution.lookupConnector);
  const wrapped: Connector = {
    def: adapter.def,
    collect: options => browserGate && browserSources.has(site.sourceId)
      ? browserGate(() => { throwIfCancelled(); return adapter.collect(options); })
      : adapter.collect(options),
  };
  return executeCollection({
    sourceId: site.sourceId, tenant: site.domain, job: 'collect:daily', limit, timeoutMs, signal,
    forceTenantObserver: true, guaranteeTenantAttempt: true, checkEmptyHttpFailure: true,
    authorizePersistence: () => {
      if (!job.token) throw new CollectionCancellationError('lock_lost', 'Daily job has no lock token');
      if (signal?.aborted) throw signal.reason;
    },
    metadata: { ...collectionJobContext(job, 'cron'), scheduledAt: new Date(job.timestamp) },
  }, { ...execution, lookupConnector: () => wrapped });
}

export function createDailyWorkerRuntime(browserGate?: <T>(operation: () => Promise<T>) => Promise<T>) {
  const connection = makeRedis();
  const queue = new Queue<CollectJob>(DAILY_QUEUE, { connection });
  let worker: Worker<CollectJob> | undefined;
  const controllers = new Map<string, AbortController>();
  /**
   * A cobertura daily TEM aviso de alerta; o que ela não pode é despejar um por
   * site: são 158 domínios entre 00:00 e 10:28 e o mesmo modelo aparece em
   * vários. O teto é por alerta e por canal — push a cada 6h, e-mail uma vez ao
   * dia — e o aviso seguinte junta o que entrou no meio da janela. O hit é sempre
   * gravado, então nada se perde na tela: some só da notificação.
   *
   * A coleta regular não usa limite nenhum: lá cada lote novo é um aviso por si.
   */
  const limites = {
    push: Number(process.env.COBERTURA_PUSH_MINUTOS ?? 360),
    email: Number(process.env.COBERTURA_EMAIL_MINUTOS ?? 1440),
  };
  const execution: CollectionExecutionDependencies = {
    lookupConnector: getConnector, startRun, finishRun, upsertLots, observerForCollection,
    processarAposColeta: (novos: number[]) => processarAposColeta(novos, undefined, limites),
    logError: (message, error) => console.error(message, error),
  };
  return {
    async start() {
      for (const item of dailyScheduleItems()) await queue.upsertJobScheduler(item.id,
        { pattern: item.pattern, tz: 'America/Sao_Paulo' }, { name: item.name, data: item.data,
          opts: { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 } });
      worker = new Worker<CollectJob>(DAILY_QUEUE, async job => {
        const id = job.id!; const controller = new AbortController(); controllers.set(id, controller);
        try {
          const result = await processDailyJob(job, execution, controller.signal, browserGate);
          const n = result.notifications;
          const avisos = n && n.disparos
            ? ` · alertas ${n.disparos} · push ${n.push} · e-mail ${n.emails}${n.adiados ? ` · adiados ${n.adiados}` : ''}`
            : '';
          console.log(`[daily] ${job.data.tenant}: run=${result.runId} fetched=${result.result.fetched} mapped=${result.result.lots.length} upserted=${result.upserted} skipped=${result.result.skipped}${avisos}`);
          return { runId: result.runId, fetched: result.result.fetched, upserted: result.upserted };
        } finally { controllers.delete(id); }
      }, { connection, concurrency: 1 });
      worker.on('failed', (job, error) => console.error(`[daily] ${job?.data.tenant}: ${error.message}`));
      worker.on('error', error => console.error('[daily] queue error:', error.message));
      worker.on('lockRenewalFailed', ids => {
        for (const id of ids) controllers.get(id)?.abort(new CollectionCancellationError('lock_lost'));
      });
      // Recover missed days after restart, without repeating domains already attempted today.
      const attempted = await query<{ domain: string }>(`SELECT DISTINCT domain FROM tenant_collection_attempts
        WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
          AND (job_id LIKE 'daily-%' OR job_id LIKE 'repeat:daily-site-%')`);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const covered = new Set(attempted.map(row => row.domain));
      const missing = DAILY_SITES.filter(site => !covered.has(site.domain));
      for (const site of missing) await queue.add(`daily-catchup:${site.domain}`,
        { sourceId: site.sourceId, tenant: site.domain, limit: 5, timeoutMs: 45000 },
        { jobId: `daily-${today}-${site.domain.replaceAll('.', '-')}`, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
      console.log(`[daily] scheduled=${DAILY_SITES.length}; required120=${DAILY_SITES.filter(s => s.required120).length}; catchup=${missing.length}`);
    },
    async stop() {
      for (const controller of controllers.values()) controller.abort(new CollectionCancellationError('shutdown'));
      await worker?.close(); await queue.close(); await connection.quit();
    },
  };
}
