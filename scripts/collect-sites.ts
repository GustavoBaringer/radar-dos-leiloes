import { makeRedis, CHANNEL_UPDATES } from '../src/queue/runtime.js';
import { boundedCollection, workerDeployment } from '../src/queue/deployment.js';
import {
  REQUESTED_COVERAGE_DOMAINS20,
  TENANT_COVERAGE,
  TENANT_DEFAULT_TIMEOUT_MS,
  coverageReadiness,
  migrateLegacyTenantSchedulers,
  registerTenantSchedulers,
  tenantScheduleItems,
} from '../src/queue/tenant-coverage.js';

const args = process.argv.slice(2);
const runAt = args.indexOf('--run');
const limitAt = args.indexOf('--limit');
const schedule = args.includes('--schedule');
const migrationAt = args.indexOf('--migrate-legacy');
const target = runAt >= 0 ? args[runAt + 1] : undefined;
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 1200;
const snapshotPath = migrationAt >= 0 ? args[migrationAt + 1] : undefined;
if ((runAt >= 0 && !target) || (migrationAt >= 0 && !snapshotPath) || (migrationAt >= 0 && !schedule) ||
    !Number.isInteger(limit) || limit < 1 || args.some((x, i) =>
      (x === '--run' && i !== runAt) || (x === '--limit' && i !== limitAt) || (x === '--migrate-legacy' && i !== migrationAt))) {
  throw new Error('Usage: collect-sites [--run <domain|all>] [--limit N] [--schedule [--migrate-legacy <verified-snapshot.json>]');
}

const readiness = coverageReadiness();
const domain = target && target !== 'all' ? target.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : undefined;
const pair = domain ? TENANT_COVERAGE.find((item) => item.domain === domain) : undefined;
const requested = domain ? REQUESTED_COVERAGE_DOMAINS20.find((item) => item.domain === domain) : undefined;
if (domain && !pair) throw new Error(requested ? `${domain} is pending: ${'reason' in requested ? requested.reason : 'coverage pair pending'}` : `Unknown reviewed domain: ${domain}`);
if (target === 'all' && readiness.pending.length) throw new Error(`Refusing incomplete all-domain run: ${readiness.pending.length} requested domains remain pending`);
if (schedule && readiness.pending.length) throw new Error(`Refusing all-domain schedule: ${readiness.pending.length} requested domains remain pending`);

if (runAt < 0 && !schedule) {
  console.log(JSON.stringify({ configured: TENANT_COVERAGE, requested: REQUESTED_COVERAGE_DOMAINS20,
    readiness, scheduleCommand: '--schedule' }, null, 2));
} else {
  const { pool, query } = await import('../src/core/db.js');
  const { getConnector } = await import('../src/connectors/index.js');
  const { startRun, finishRun, upsertLots } = await import('../src/core/repo.js');
  const { processarAposColeta } = await import('../src/application/services/collection/post-collection.js');
  const { observerForCollection } = await import('../src/application/services/collection/collection-observer.js');
  const { executeCollection } = await import('../src/application/services/collection/collection-execution.js');
  const { tenantExecutionOptions } = await import('../src/queue/tenant-coverage.js');
  const deployment = workerDeployment();
  let pub: ReturnType<typeof makeRedis> | undefined;
  const opened: Array<{ queue: any; connection: ReturnType<typeof makeRedis> }> = [];
  let failed = false;
  let currentRunId: number | undefined;
  try {
    if (schedule) {
      const { createTenantCollectQueue, createCollectQueue } = await import('../src/queue/runtime.js');
      const enabled = await query<{ id: string; enabled: boolean }>(
        'SELECT id, enabled FROM sources WHERE id = ANY($1::text[])',
        [[...new Set(TENANT_COVERAGE.map((item) => item.sourceId))]],
      );
      const sourceStates = new Map(enabled.map((row) => [row.id, row.enabled]));
      const allowed = new Set([...sourceStates].filter(([id, isEnabled]) => isEnabled && (!deployment.sources || deployment.sources.has(id))).map(([id]) => id));
      const excluded = tenantScheduleItems().filter((item) => !allowed.has(item.sourceId));
      console.log(JSON.stringify({ action: 'schedule', configured: TENANT_COVERAGE.length,
        active: tenantScheduleItems(allowed).length, excludedDomains: excluded.map((item) => item.data.tenant), readiness }));

      const register = async () => {
        const connection = makeRedis();
        const queue = createTenantCollectQueue(connection);
        opened.push({ queue, connection });
        await registerTenantSchedulers(queue as any, 'America/Sao_Paulo', allowed, deployment.sourceTimeouts);
      };
      if (migrationAt >= 0) {
        const { readFile } = await import('node:fs/promises');
        const snapshot = JSON.parse(await readFile(snapshotPath!, 'utf8'));
        const legacyConnection = makeRedis();
        const legacyQueue = createCollectQueue(legacyConnection);
        opened.push({ queue: legacyQueue, connection: legacyConnection });
        await migrateLegacyTenantSchedulers(legacyQueue, snapshot, register);
      } else {
        await register();
      }
    }

    if (runAt >= 0) {
      pub = makeRedis();
      const publish = (payload: unknown) => pub!.publish(CHANNEL_UPDATES, JSON.stringify(payload));
      const ids = target === 'all' ? [...TENANT_COVERAGE] : TENANT_COVERAGE.filter((item) => item.domain === domain);
      for (const item of ids) {
        currentRunId = undefined;
        const budgetMs = Math.min(deployment.sourceTimeouts[item.sourceId] ?? TENANT_DEFAULT_TIMEOUT_MS, TENANT_DEFAULT_TIMEOUT_MS);
        try {
          const connector = getConnector(item.sourceId);
          if (!connector) throw new Error(`Unknown connector: ${item.sourceId}`);
          if (deployment.sources && !deployment.sources.has(item.sourceId)) throw new Error(`Source outside WORKER_SOURCES: ${item.sourceId}`);
          const sources = await query<{ enabled: boolean }>('SELECT enabled FROM sources WHERE id = $1', [item.sourceId]);
          if (sources[0]?.enabled !== true) throw new Error(`Source is disabled or unregistered: ${item.sourceId}`);
          const bounded = boundedCollection(deployment, item.sourceId, connector.def.method, limit);
          const result = await executeCollection({
            sourceId: item.sourceId,
            ...tenantExecutionOptions(item.sourceId, item.domain),
            limit: Math.min(1200, bounded.limit),
            timeoutMs: budgetMs,
            metadata: { origin: 'manual' },
            publish,
          }, {
            lookupConnector: getConnector,
            startRun: async (...startArgs: Parameters<typeof startRun>) => {
              currentRunId = await startRun(...startArgs);
              return currentRunId;
            },
            finishRun,
            upsertLots,
            observerForCollection,
            processarAposColeta,
            publishNotification: publish,
          });
          console.log(JSON.stringify({ domain: item.domain, source: item.sourceId, runId: result.runId,
            lidos: result.result.fetched, mapeados: result.result.lots.length, gravados: result.upserted,
            descartados: result.result.skipped, httpStatus: result.result.httpStatus,
            limit: Math.min(1200, bounded.limit), budgetMs, completeness: 'bounded; exhaustiveness not guaranteed' }));
        } catch (error) {
          failed = true;
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ domain: item.domain, source: item.sourceId, runId: currentRunId,
            budgetMs, partialPossible: true,
            error: message.replace(/(redis:\/\/|postgres(?:ql)?:\/\/)[^\s]*/gi, '$1[redacted]') }));
        }
      }
    }
  } finally {
    await Promise.allSettled([
      ...opened.map(async ({ queue, connection }) => { await queue.close(); await connection.quit(); }),
      ...(pub ? [pub.quit()] : []),
      pool.end(),
    ]);
  }
  if (failed) process.exitCode = 1;
}
