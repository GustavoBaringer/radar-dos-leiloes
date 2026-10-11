import assert from 'node:assert/strict';
import { TENANT_COVERAGE, isTenantCoveragePair, registerTenantSchedulers, tenantScheduleItems } from '../src/queue/tenant-coverage.js';

assert.equal(TENANT_COVERAGE.length, 11);
assert.equal(isTenantCoveragePair('soleon', 'realizaleiloes.com.br'), true);
assert.equal(isTenantCoveragePair('soleon', 'missing.example'), false);
const calls: unknown[] = [];
const unrelated = { id: 'collect-other-source' };
const queue = {
  async upsertJobScheduler(...args: unknown[]) { calls.push(args); },
};
await registerTenantSchedulers(queue, 'America/Sao_Paulo');
await registerTenantSchedulers(queue, 'America/Sao_Paulo');
assert.equal(calls.length, 22);
assert.equal(new Set(calls.map((call) => (call as unknown[])[0])).size, 11);
assert.equal((tenantScheduleItems()[0] as any).data.tenant, 'realizaleiloes.com.br');
assert.equal((tenantScheduleItems()[0] as any).data.timeoutMs, 600_000);
assert.equal((tenantScheduleItems(undefined, { soleon: 240_000 })[0] as any).data.timeoutMs, 240_000);
assert.equal((calls[0] as any[])[2].opts.attempts, 1);
assert.equal(unrelated.id, 'collect-other-source');
console.log('tenant coverage manifest/schedule OK');
