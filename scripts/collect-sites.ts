import { makeRedis, CHANNEL_UPDATES } from '../src/queue/runtime.js';
import { boundedCollection, workerDeployment } from '../src/queue/deployment.js';
import { TENANT_COVERAGE, TENANT_DEFAULT_TIMEOUT_MS, registerTenantSchedulers } from '../src/queue/tenant-coverage.js';

const args = process.argv.slice(2);
const runAt = args.indexOf('--run');
const limitAt = args.indexOf('--limit');
const schedule = args.includes('--schedule');
const target = runAt >= 0 ? args[runAt + 1] : undefined;
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 1200;
if ((runAt >= 0 && !target) || !Number.isInteger(limit) || limit < 1 || args.some((x, i) => x === '--run' && i !== runAt || x === '--limit' && i !== limitAt)) {
  throw new Error('Usage: collect-sites [--run <domain|all>] [--limit N] [--schedule]');
}

const pairs = target === 'all' ? [...TENANT_COVERAGE]
  : target ? TENANT_COVERAGE.filter((item) => item.domain === target.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))
  : [...TENANT_COVERAGE];
if (target && target !== 'all' && !pairs.length) throw new Error(`Unknown reviewed domain: ${target}`);

if (runAt < 0 && !schedule) {
  console.log(JSON.stringify({ manifest: TENANT_COVERAGE, scheduleCommand: '--schedule', warning: 'Scheduling requires a tenant-compatible worker consumer.' }, null, 2));
} else {
  const { pool, query } = await import('../src/core/db.js');
  const { getConnector } = await import('../src/connectors/index.js');
  const { ensureSources, finishRun, startRun, upsertLots } = await import('../src/core/repo.js');
  const { processarAposColeta } = await import('../src/core/pos-coleta.js');
  const { observerForCollection } = await import('../src/core/collection-observer.js');
  const deployment = workerDeployment();
  const pub = makeRedis();
  let collectQueue: any;
  let schedulerConnection: ReturnType<typeof makeRedis> | undefined;
  let queues: any;
  let failed = false;
  let runId: number | undefined;
  const publish = (payload: unknown) => pub.publish(CHANNEL_UPDATES, JSON.stringify(payload));

  try {
    await ensureSources();
    if (schedule) {
      const enabled = await query<{ id: string }>('SELECT id FROM sources WHERE enabled = true');
      const configured = deployment.sources;
      const allowed = new Set(enabled.map((x) => x.id).filter((id) => !configured || configured.has(id)));
      const { Queue } = await import('bullmq');
      schedulerConnection = makeRedis();
      collectQueue = new Queue('collect', { connection: schedulerConnection });
      await registerTenantSchedulers(collectQueue, 'America/Sao_Paulo', allowed, deployment.sourceTimeouts);
      await collectQueue.close();
      collectQueue = undefined;
      await schedulerConnection.quit();
      schedulerConnection = undefined;
    }

    if (runAt >= 0) {
      // Importing worker is intentional only for execution, never for list/schedule-only mode.
      queues = await import('../src/queue/queues.js');
      const worker = await import('../src/queue/worker.js');
      const deps = worker.createWorkerDeps({
        lookupConnector: getConnector,
        startRun: async (...args: Parameters<typeof startRun>) => {
          runId = await startRun(...args);
          return runId;
        },
        finishRun,
        upsertLots,
        observerForCollection,
        processarAposColeta,
        publishNotification: publish,
      });
      for (const item of pairs) {
        runId = undefined;
        let budgetMs = deployment.sourceTimeouts[item.sourceId] ?? TENANT_DEFAULT_TIMEOUT_MS;
        try {
          const c = getConnector(item.sourceId);
          if (!c) throw new Error(`Unknown connector: ${item.sourceId}`);
          if (deployment.sources && !deployment.sources.has(item.sourceId)) throw new Error(`Source outside WORKER_SOURCES: ${item.sourceId}`);
          const enabled = await query<{ enabled: boolean }>('SELECT enabled FROM sources WHERE id = $1', [item.sourceId]);
          if (!enabled[0]?.enabled) throw new Error(`Source is disabled or unregistered: ${item.sourceId}`);
          const bounded = boundedCollection(deployment, item.sourceId, c.def.method, limit);
          const result = await worker.executeWorkerCollect({
            sourceId: item.sourceId,
            tenant: item.domain,
            limit: bounded.limit,
            timeoutMs: budgetMs,
            metadata: { origin: 'manual' },
            publish,
          }, deps);
          console.log(JSON.stringify({ domain: item.domain, source: item.sourceId, runId: result.runId,
            lidos: result.result.fetched, mapeados: result.result.lots.length,
            gravados: result.upserted, descartados: result.result.skipped,
            descartadosPersistencia: null, httpStatus: result.result.httpStatus, limit: bounded.limit,
            budgetMs, completeness: 'bounded; exhaustiveness not guaranteed' }));
        } catch (error) {
          failed = true;
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ domain: item.domain, source: item.sourceId, runId, budgetMs,
            partialPossible: true, error: message.replace(/(redis:\/\/|postgres(?:ql)?:\/\/)[^\s]*/gi, '$1[redacted]') }));
        }
      }
    }
  } finally {
    await Promise.allSettled([
      ...(collectQueue ? [collectQueue.close()] : []),
      ...(schedulerConnection ? [schedulerConnection.quit()] : []),
      ...(queues ? [queues.collectQueue, queues.refreshQueue, queues.discoverQueue].map(async (queue) => {
        const client = await queue.client;
        await queue.close();
        await client.quit();
      }) : []),
      pub.quit(),
      pool.end(),
    ]);
  }
  if (failed) process.exitCode = 1;
}
