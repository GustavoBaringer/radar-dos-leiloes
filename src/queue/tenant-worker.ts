import { pathToFileURL } from 'node:url';
import { Worker, type Job, type Processor } from 'bullmq';
import { getConnector } from '../connectors/index.js';
import { finishRun, startRun, upsertLots } from '../core/repo.js';
import { processarAposColeta } from '../application/services/collection/post-collection.js';
import { query } from '../core/db.js';
import { collectionJobContext, observerForCollection } from '../application/services/collection/collection-observer.js';
import { CollectionService, type CollectionExecutionDependencies, type CollectionExecutionOptions } from '../application/services/collection/collection-execution.js';
import { createCollectionContext, type CollectionContext } from '../bootstrap/collection-context.js';
import { CollectionCancellationError } from '../infra/collection/collection-cancellation.js';
import { workerDeployment, boundedCollection } from './deployment.js';
import {
  assertTenantCoveragePair,
  assertTenantSourceIsEnabled,
  coverageReadiness,
  registerTenantSchedulers,
  TENANT_DEFAULT_TIMEOUT_MS,
  TENANT_COVERAGE,
  tenantScheduleItems,
  tenantExecutionOptions,
} from './tenant-coverage.js';
import { CHANNEL_UPDATES, createTenantCollectQueue, makeRedis, QUEUE_COLLECT_TENANT, type CollectJob } from './runtime.js';

export interface TenantWorkerJob extends Job<CollectJob> {
  token?: string;
}

export interface TenantProcessorDependencies {
  execution: CollectionExecutionDependencies;
  isSourceEnabled: (sourceId: string) => Promise<boolean>;
  settings: ReturnType<typeof workerDeployment>;
  publish?: CollectionExecutionOptions['publish'];
  service?: CollectionService;
}

export interface TenantProcessor {
  process: Processor<CollectJob>;
  cancel: (jobIds: string[], kind?: 'shutdown' | 'lock_lost') => void;
  cancelAll: () => void;
}

export function createTenantProcessor(deps: TenantProcessorDependencies): TenantProcessor {
  const service = deps.service ?? new CollectionService(deps.execution);
  const controllers = new Map<string, AbortController>();
  const cancel = (jobIds: string[], kind: 'shutdown' | 'lock_lost' = 'lock_lost') => {
    for (const id of jobIds) controllers.get(id)?.abort(new CollectionCancellationError(kind));
  };
  const cancelAll = () => cancel([...controllers.keys()], 'shutdown');

  const process: Processor<CollectJob> = async (job, token, bullSignal) => {
    const { sourceId, tenant, limit, timeoutMs: requestedTimeout } = job.data ?? ({} as CollectJob);
    if (typeof tenant !== 'string') throw new Error('Invalid reviewed tenant pair: missing tenant domain');
    assertTenantCoveragePair(sourceId, tenant);
    if (deps.settings.sources && !deps.settings.sources.has(sourceId)) throw new Error(`Source outside WORKER_SOURCES: ${sourceId}`);
    await assertTenantSourceIsEnabled(sourceId, deps.isSourceEnabled);
    const connector = deps.execution.lookupConnector(sourceId);
    if (!connector) throw new Error(`Unknown tenant connector: ${sourceId}`);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid tenant collection limit');
    if (requestedTimeout !== undefined && (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1)) {
      throw new Error('Invalid tenant collection timeout');
    }

    const bounded = boundedCollection(deps.settings, sourceId, connector.def.method, limit);
    const finalLimit = Math.min(1200, bounded.limit);
    const sourceTimeout = deps.settings.sourceTimeouts[sourceId] ?? TENANT_DEFAULT_TIMEOUT_MS;
    const finalTimeout = Math.min(TENANT_DEFAULT_TIMEOUT_MS, sourceTimeout, requestedTimeout ?? TENANT_DEFAULT_TIMEOUT_MS);
    const id = job.id ?? job.name;
    const controller = new AbortController();
    controllers.set(id, controller);
    const onBullAbort = () => controller.abort(new CollectionCancellationError('shutdown', 'tenant worker closing'));
    if (bullSignal?.aborted) onBullAbort();
    else bullSignal?.addEventListener('abort', onBullAbort, { once: true });

    try {
      const options = tenantExecutionOptions(sourceId, tenant);
      const result = await service.execute({
        sourceId,
        ...options,
        limit: finalLimit,
        timeoutMs: finalTimeout,
        metadata: collectionJobContext(job, 'cron'),
        signal: controller.signal,
        checkEmptyHttpFailure: true,
        authorizePersistence: () => {
          if (!token) throw new CollectionCancellationError('lock_lost', `job ${id} has no lock token`);
        },
        publish: deps.publish,
      });
      return { runId: result.runId, fetched: result.result.fetched, upserted: result.upserted, skipped: result.result.skipped };
    } finally {
      bullSignal?.removeEventListener('abort', onBullAbort);
      controllers.delete(id);
    }
  };
  return { process, cancel, cancelAll };
}

export interface TenantWorkerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createTenantWorkerRuntime(): TenantWorkerRuntime {
  let worker: Worker<CollectJob> | undefined;
  let workerConnection: ReturnType<typeof makeRedis> | undefined;
  let publisher: ReturnType<typeof makeRedis> | undefined;
  let started = false;
  let stopped = false;
  const settings = workerDeployment();
  let processor: TenantProcessor | undefined;
  let context: CollectionContext | undefined;

  const publish = async (payload: unknown) => {
    publisher ??= makeRedis();
    return publisher.publish(CHANNEL_UPDATES, JSON.stringify(payload));
  };
  const execution: CollectionExecutionDependencies = {
    lookupConnector: getConnector,
    startRun,
    finishRun,
    upsertLots,
    observerForCollection,
    processarAposColeta,
    publishNotification: publish,
    logError: (message, error) => console.error(message, error),
  };

  return {
    async start() {
      if (stopped) throw new Error('tenant worker runtime already stopped');
      if (started) return;
      context = await createCollectionContext({ overrides: execution });
      const readiness = coverageReadiness();
      console.log(`[tenant-worker] cobertura configurada=${readiness.configured}/${readiness.union}; pendentes=${readiness.pending.length}`);
      if (readiness.pending.length) console.warn(`[tenant-worker] pendentes: ${readiness.pending.map((item) => item.domain).join(', ')}`);
      const sourceIds = [...new Set(TENANT_COVERAGE.map((item) => item.sourceId))];
      const enabledRows = await query<{ id: string; enabled: boolean }>(
        'SELECT id, enabled FROM sources WHERE id = ANY($1::text[])', [sourceIds],
      );
      const enabled = new Set(enabledRows.filter((row) => row.enabled && (!settings.sources || settings.sources.has(row.id))).map((row) => row.id));
      const excluded = sourceIds.filter((id) => !enabled.has(id));
      if (excluded.length) console.warn(`[tenant-worker] fontes desabilitadas/fora de WORKER_SOURCES: ${excluded.join(', ')}`);

      const scheduleConnection = makeRedis();
      const schedulerQueue = createTenantCollectQueue(scheduleConnection);
      let schedulerError: unknown;
      try {
        await registerTenantSchedulers(schedulerQueue as any, 'America/Sao_Paulo', enabled, settings.sourceTimeouts);
      } catch (error) {
        schedulerError = error;
      } finally {
        const closed = await Promise.allSettled([schedulerQueue.close(), scheduleConnection.quit()]);
        if (!schedulerError) schedulerError = closed.find((result) => result.status === 'rejected')?.reason;
      }
      if (schedulerError) throw schedulerError;

      processor = createTenantProcessor({
        execution,
        service: context.service,
        isSourceEnabled: async (sourceId) => {
          const rows = await query<{ enabled: boolean }>('SELECT enabled FROM sources WHERE id = $1', [sourceId]);
          return rows[0]?.enabled === true;
        },
        settings,
        publish: (event) => publish(event),
      });
      workerConnection = makeRedis();
      worker = new Worker<CollectJob>(QUEUE_COLLECT_TENANT, processor.process, { connection: workerConnection, concurrency: 2 });
      worker.on('failed', (job, error) => console.error(`[tenant-worker] ${job?.data.tenant ?? 'unknown'} failed: ${error.message}`));
      worker.on('error', (error) => console.error('[tenant-worker] worker:', error.message));
      worker.on('lockRenewalFailed', (jobIds) => {
        console.error(`[tenant-worker] lost locks: ${jobIds.join(' ')}`);
        processor?.cancel(jobIds, 'lock_lost');
      });
      started = true;
      console.log(`[tenant-worker] consuming ${QUEUE_COLLECT_TENANT} (concurrency=2; pairs=${tenantScheduleItems(enabled).length}/${readiness.union})`);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      processor?.cancelAll();
      let closeError: unknown;
      try { await worker?.close(); } catch (error) { closeError = error; }
      worker = undefined;
      const cleanup = await Promise.allSettled([
        ...(workerConnection ? [workerConnection.quit()] : []),
        ...(publisher ? [publisher.quit()] : []),
        ...(context ? [context.close()] : []),
      ]);
      workerConnection = undefined;
      publisher = undefined;
      started = false;
      if (closeError) throw closeError;
      const cleanupError = cleanup.find((result) => result.status === 'rejected');
      if (cleanupError?.status === 'rejected') throw cleanupError.reason;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createTenantWorkerRuntime();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.stop().catch((closeError) => console.error('[tenant-worker] shutdown after startup failure:', closeError));
    throw error;
  }
}
