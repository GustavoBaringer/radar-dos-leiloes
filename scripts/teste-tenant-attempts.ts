import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantObserver } from '../src/core/tenant-attempts.js';

const context = { runId: 12, sourceId: 'source-x', origin: 'cron' as const };
function fake() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const execute = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return [{ id: 7 }];
  };
  return { calls, execute };
}

test('inserts before returning attempt and normalizes domain/context', async () => {
  const f = fake(); const scheduledAt = new Date(0);
  const attempt = await createTenantObserver({ ...context, origin: 'manual', jobId: 'job-1', scheduledAt }, f.execute).start('WWW.Example.COM.');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params[2], 'example.com');
  assert.deepEqual(f.calls[0].params.slice(3), ['manual', 'job-1', scheduledAt]);
  attempt.response(200); await attempt.finish({ fetched: 0, skipped: 0, returned: 0 });
});

test('completed empty and all-filtered are completed with raw counts', async () => {
  for (const stats of [{ fetched: 0, skipped: 0, returned: 0 }, { fetched: 5, skipped: 5, returned: 0 }]) {
    const f = fake(); const attempt = await createTenantObserver(context, f.execute).start('example.com');
    attempt.response(200); await attempt.finish(stats);
    assert.equal(f.calls[1].params[1], 'completed');
    assert.deepEqual(f.calls[1].params.slice(2, 5), [stats.fetched, stats.skipped, stats.returned]);
  }
});

test('truncation, HTTP failure, network failure, and no response are not completed', async () => {
  const cases = [
    { response: 200, stats: { fetched: 1, skipped: 0, returned: 1, truncated: true }, state: 'partial', error: 'budget' },
    { response: 403, stats: { fetched: 0, skipped: 0, returned: 0 }, state: 'failed', error: 'http' },
    { failure: true, stats: { fetched: 2, skipped: 0, returned: 1 }, state: 'partial', error: 'network' },
    { stats: { fetched: 0, skipped: 0, returned: 0 }, state: 'failed', error: 'no_response' },
  ];
  for (const c of cases) {
    const f = fake(); const a = await createTenantObserver(context, f.execute).start('example.com');
    if (c.response) a.response(c.response); if (c.failure) a.failure(); await a.finish(c.stats);
    assert.equal(f.calls[1].params[1], c.state); assert.equal(f.calls[1].params[7], c.error);
  }
});

test('unfinished attempts remain running; insert failure prevents fetch attempt', async () => {
  const f = fake(); await createTenantObserver(context, f.execute).start('example.com');
  assert.equal(f.calls.length, 1);
  let network = 0;
  const fail = async () => { throw new Error('insert failed'); };
  await assert.rejects(createTenantObserver(context, fail).start('example.com').then(() => { network++; }));
  assert.equal(network, 0);
});

test('finish can retry a failed write, then cannot finish or observe again', async () => {
  let failUpdate = false; const f = fake();
  const execute = async (sql: string, params: any[] = []) => {
    f.calls.push({ sql, params });
    if (sql.startsWith('UPDATE') && failUpdate) { failUpdate = false; throw new Error('update failed'); }
    return [{ id: 7 }];
  };
  const a = await createTenantObserver(context, execute).start('example.com'); a.response(200);
  failUpdate = true; await assert.rejects(a.finish({ fetched: 1, skipped: 0, returned: 1 }));
  await a.finish({ fetched: 1, skipped: 0, returned: 1 });
  await assert.rejects(a.finish({ fetched: 1, skipped: 0, returned: 1 }));
  assert.throws(() => a.response(200));
});

test('invalid context or domain is rejected before ledger writes', async () => {
  const f = fake();
  assert.throws(() => createTenantObserver({ ...context, runId: 0 }, f.execute));
  const observer = createTenantObserver(context, f.execute);
  await assert.rejects(observer.start('https://user@example.com/path'));
  await assert.rejects(observer.start('127.0.0.1'));
  assert.equal(f.calls.length, 0);
});
