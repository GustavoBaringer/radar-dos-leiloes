import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionJobContext, observerForCollection } from '../src/core/collection-observer.js';

function fake() {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const execute = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    return [{ id: 9 }];
  };
  return { calls, execute };
}

test('ledger disabled is inert; enabled uses injectable executor', async () => {
  const context = { runId: 2, sourceId: 'source', origin: 'manual' as const };
  const disabled = fake();
  assert.equal(observerForCollection(context, false, disabled.execute), undefined);
  assert.equal(disabled.calls.length, 0);

  const enabled = fake();
  const observer = observerForCollection(context, true, enabled.execute)!;
  const attempt = await observer.start('example.com');
  attempt.response(200);
  await attempt.finish({ fetched: 3, skipped: 1, returned: 2 });
  assert.equal(enabled.calls.length, 2);
  assert.equal(enabled.calls[0].params?.[0], 2);
});

test('manual and refresh job contexts do not invent schedule times', () => {
  assert.deepEqual(collectionJobContext(undefined, 'refresh'), { origin: 'refresh' });
  assert.deepEqual(collectionJobContext({ id: 'manual-42' }, 'cron'), { origin: 'cron', jobId: 'manual-42' });
  assert.deepEqual(collectionJobContext({ id: 'repeat:refresh-hot:bad' }, 'refresh'), {
    origin: 'refresh', jobId: 'repeat:refresh-hot:bad',
  });
});

test('repeat job id yields the scheduled timestamp, not job creation metadata', () => {
  const expected = 1_791_374_400_000;
  const context = collectionJobContext({ id: `repeat:collect-source:${expected}` }, 'cron');
  assert.equal(context.origin, 'cron');
  assert.equal(context.jobId, `repeat:collect-source:${expected}`);
  assert.equal(context.scheduledAt?.getTime(), expected);
});
