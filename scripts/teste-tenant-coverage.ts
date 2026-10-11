import assert from 'node:assert/strict';
import { QUEUE_COLLECT, QUEUE_COLLECT_TENANT } from '../src/queue/runtime.js';
import {
  COVERAGE_UNION_SIZE,
  LEGACY_TENANT_SCHEDULER_IDS,
  REQUESTED_COVERAGE_DOMAINS20,
  TENANT_COVERAGE,
  coverageReadiness,
  isTenantCoveragePair,
  migrateLegacyTenantSchedulers,
  registerTenantSchedulers,
  tenantScheduleItems,
} from '../src/queue/tenant-coverage.js';

assert.equal(TENANT_COVERAGE.length, 19);
assert.equal(REQUESTED_COVERAGE_DOMAINS20.length, 20);
assert.equal(coverageReadiness().union, COVERAGE_UNION_SIZE);
assert.equal(coverageReadiness().pending.length, 10);
assert.equal(isTenantCoveragePair('soleon', 'realizaleiloes.com.br'), true);
assert.equal(isTenantCoveragePair('soleon', 'cassianoleiloes.com.br'), true);
assert.equal(isTenantCoveragePair('soleon', 'missing.example'), false);
assert.notEqual(QUEUE_COLLECT_TENANT, QUEUE_COLLECT);
const calls: unknown[] = [];
const unrelated = { id: 'collect-some-auctioneer' };
const queue = {
  async upsertJobScheduler(...args: unknown[]) { calls.push(args); },
};
await registerTenantSchedulers(queue, 'America/Sao_Paulo');
await registerTenantSchedulers(queue, 'America/Sao_Paulo');
assert.equal(calls.length, 38);
assert.equal(new Set(calls.map((call) => (call as unknown[])[0])).size, 19);
assert.equal((tenantScheduleItems()[0] as any).data.tenant, 'realizaleiloes.com.br');
assert.equal((tenantScheduleItems()[0] as any).data.timeoutMs, 600_000);
assert.equal((tenantScheduleItems(undefined, { soleon: 240_000 })[0] as any).data.timeoutMs, 240_000);
assert.equal((calls[0] as any[])[2].opts.attempts, 1);
assert.equal((calls[0] as any[])[1].tz, 'America/Sao_Paulo');
assert.equal((calls[0] as any[])[2].data.limit, 1200);

const sourceSchedulerIds = Array.from({ length: 48 }, (_, i) => `collect-source-${i}`);
const preflight = { redis: {
  schedulerCount: 59,
  sourceSchedulerCount: 48,
  tenantSchedulerCount: 11,
  schedulers: [...sourceSchedulerIds.map((key) => ({ key })), ...LEGACY_TENANT_SCHEDULER_IDS.map((key) => ({ key }))],
} };
const remaining = new Set([...sourceSchedulerIds, ...LEGACY_TENANT_SCHEDULER_IDS]);
const order: string[] = [];
await migrateLegacyTenantSchedulers({
  async removeJobScheduler(id) { order.push(`remove:${id}`); remaining.delete(id); },
}, preflight, async () => { order.push('register-new'); });
assert.equal(order[0], 'register-new');
assert.equal(order.length, 12);
assert.equal(remaining.size, 48);
assert.ok(sourceSchedulerIds.every((id) => remaining.has(id)));
await assert.rejects(() => migrateLegacyTenantSchedulers({ async removeJobScheduler() {} }, { redis: {} }, async () => {}), /verified 59-scheduler/);
console.log('tenant coverage manifest/schedule OK');
