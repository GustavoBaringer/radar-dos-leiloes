import assert from 'node:assert/strict';
import { executeCollection, type CollectionExecutionDependencies } from '../src/core/collection-execution.js';
import { observerForCollection } from '../src/core/collection-observer.js';
import { assertTenantSourceIsEnabled, tenantExecutionOptions } from '../src/queue/tenant-coverage.js';

let started: Array<[string, string, number]> = [];
let tenantSeen: string | undefined;
let observerCreated = false;
const deps: CollectionExecutionDependencies = {
  lookupConnector: () => ({ def: { id: 'soleon', name: 'soleon', method: 'html', tier: 1, siteUrl: '' }, async collect(opts) {
    tenantSeen = opts.tenant;
    assert.ok(opts.observer);
    return { lots: [], fetched: 1, skipped: 0 };
  } }),
  startRun: async (sourceId, job, limit) => { started.push([sourceId, job, limit]); return 1; },
  finishRun: async () => undefined,
  upsertLots: async () => ({ upserted: 0, novos: [], bidChanges: [] }),
  observerForCollection: (_ctx, force) => { observerCreated ||= force === true; return {} as any; },
  processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
};
const publish = async () => undefined;
assert.throws(() => tenantExecutionOptions('soleon', ' '), /Invalid reviewed tenant pair/);
assert.equal(started.length, 0);
assert.throws(() => tenantExecutionOptions('vlance', 'rjleiloes.com.br'), /Invalid reviewed tenant pair/);
assert.equal(started.length, 0);
let enabledLookups = 0;
await assert.rejects(() => assertTenantSourceIsEnabled('soleon', async () => { enabledLookups++; return false; }), /disabled or unregistered/);
assert.equal(enabledLookups, 1);
await assertTenantSourceIsEnabled('soleon', async () => true);
await executeCollection({ sourceId: 'soleon', ...tenantExecutionOptions('soleon', 'realizaleiloes.com.br'), limit: 2,
  publish }, deps);
assert.deepEqual(started, [['soleon', 'collect:tenant', 2]]);
assert.equal(tenantSeen, 'realizaleiloes.com.br');
assert.equal(observerCreated, true);
const previous = process.env.TENANT_LEDGER_ENABLED;
delete process.env.TENANT_LEDGER_ENABLED;
assert.ok(observerForCollection({ runId: 1, sourceId: 'soleon', origin: 'manual' }, true, async () => [{ id: 1 } as any]));
if (previous !== undefined) process.env.TENANT_LEDGER_ENABLED = previous;
console.log('tenant executor forwarding/validation/observer/job bookkeeping OK');
