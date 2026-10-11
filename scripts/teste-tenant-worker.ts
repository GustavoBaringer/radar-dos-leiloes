import assert from 'node:assert/strict';
import type { CollectionExecutionDependencies } from '../src/core/collection-execution.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';
import { workerDeployment } from '../src/queue/deployment.js';
import { createTenantProcessor } from '../src/queue/tenant-worker.js';

const runs: Array<{ sourceId: string; job: string; limit: number }> = [];
const finishes: Array<{ ok: boolean; fetched?: number; error?: string }> = [];
const seen: Array<{ tenant?: string; limit: number }> = [];
let enabled = true;
let enabledChecks = 0;
let failCassiano = true;
let holdCollect = false;
let collectStarted: (() => void) | undefined;
let observerForce: boolean | undefined;
let observerContext: any;
const connector = {
  def: { id: 'soleon', name: 'soleon', method: 'api', tier: 1, siteUrl: 'https://example.test' },
  async collect(options: any) {
    seen.push({ tenant: options.tenant, limit: options.limit });
    if (holdCollect) {
      collectStarted?.();
      return new Promise<any>(() => {});
    }
    if (failCassiano && options.tenant === 'cassianoleiloes.com.br') throw new Error('tenant-specific parser failed');
    return { lots: [], fetched: 1, skipped: 0, httpStatus: 200 };
  },
} as any;
const execution: CollectionExecutionDependencies = {
  lookupConnector: () => connector,
  startRun: async (sourceId, job, limit) => { runs.push({ sourceId, job, limit }); return runs.length; },
  finishRun: async (_id, data) => { finishes.push(data); },
  upsertLots: async () => ({ upserted: 0, novos: [], bidChanges: [] }),
  observerForCollection: (context, force) => { observerContext = context; observerForce = force; return {}; },
  processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
};
const processor = createTenantProcessor({
  execution,
  isSourceEnabled: async () => { enabledChecks++; return enabled; },
  settings: workerDeployment({ WORKER_SOURCE_TIMEOUTS_MS: '{"soleon":300000}' }),
});
const job = (tenant: string, id = `repeat:collect-tenant-soleon-${tenant.replaceAll('.', '-')}:1791734820000`, limit = 9000, timeoutMs = 900000) => ({
  id,
  name: `collect:tenant:soleon:${tenant}`,
  token: 'bull-lock-token',
  data: { sourceId: 'soleon', tenant, limit, timeoutMs },
} as any);

await assert.rejects(() => processor.process(job('not-reviewed.example'), 'token'), /Invalid reviewed tenant pair/);
assert.equal(enabledChecks, 0);
assert.equal(runs.length, 0);

enabled = false;
await assert.rejects(() => processor.process(job('realizaleiloes.com.br'), 'token'), /disabled or unregistered/);
assert.equal(runs.length, 0);
enabled = true;

await assert.rejects(() => processor.process(job('cassianoleiloes.com.br'), 'token'), /tenant-specific parser failed/);
const completed = await processor.process(job('realizaleiloes.com.br'), 'token') as any;
assert.equal(completed.fetched, 1);
assert.deepEqual(runs.map((run) => run.job), ['collect:tenant', 'collect:tenant']);
assert.deepEqual(runs.map((run) => run.limit), [1200, 1200]);
assert.deepEqual(seen.slice(-2).map((call) => call.tenant), ['cassianoleiloes.com.br', 'realizaleiloes.com.br']);
assert.equal(observerForce, true);
assert.equal(observerContext.origin, 'cron');
assert.equal(observerContext.jobId, 'repeat:collect-tenant-soleon-realizaleiloes-com-br:1791734820000');
assert.equal(observerContext.scheduledAt.toISOString(), new Date(1791734820000).toISOString());
assert.equal(finishes[0]?.ok, false);
assert.equal(finishes.at(-1)?.ok, true);

holdCollect = true;
let started!: () => void;
const startedPromise = new Promise<void>((resolve) => { started = resolve; });
collectStarted = started;
const cancelId = 'repeat:cancel-test';
const inFlight = processor.process(job('realizaleiloes.com.br', cancelId), 'token');
await startedPromise;
processor.cancel([cancelId], 'lock_lost');
await assert.rejects(inFlight, (error: any) => error instanceof CollectionCancellationError && error.kind === 'lock_lost');
assert.equal(finishes.at(-1)?.ok, false);
processor.cancelAll();
console.log('dedicated tenant worker validation, isolation, budgets, observer and cancellation OK');
