import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountContextError,
  buildMePayload,
  createAccountContext,
  VISIBLE_FAVORITE_PREDICATE,
  type AccountContextQuery,
} from '../src/core/account-context.js';
import { VENCIDO } from '../src/core/encerramento.js';
import type { PublicLot } from '../src/core/public-dto.js';
import type { query as dbQuery } from '../src/core/db.js';

const queryTypeCompatibility: AccountContextQuery = null as unknown as typeof dbQuery;
void queryTypeCompatibility;

const lot = (id: number, favorited?: boolean) => ({ id, favorited, title_raw: `lot ${id}` } as unknown as PublicLot & { favorited?: boolean });

test('/api/me payload helper emits summary at root and preserves account identity contract', () => {
  const payload = buildMePayload({
    papel: 'admin', oidc: true, logado: true,
    conta: { id: 42, email: 'owner@example.test', nome: 'Owner', porProvedor: true },
  }, { favoriteCount: 17, unreadAlertCount: 31 });
  assert.deepEqual(payload, {
    papel: 'admin', oidc: true, logado: true,
    conta: { id: 42, email: 'owner@example.test', nome: 'Owner', porProvedor: true },
    favoriteCount: 17, unreadAlertCount: 31,
  });
});

test('visible favorites use exact shared terminal/expired predicate', async () => {
  assert.equal(VISIBLE_FAVORITE_PREDICATE, `l.status NOT IN ('encerrado','vendido') AND NOT ${VENCIDO}`);
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const query: AccountContextQuery = async (sql, params) => { queries.push({ sql, params }); return [{ count: 4 }]; };
  const ctx = createAccountContext(query);
  const result = await ctx.summarize(42);
  assert.equal(result.favoriteCount, 4);
  assert(queries[0].sql.includes(VISIBLE_FAVORITE_PREDICATE));
  assert(queries[0].sql.includes('JOIN lots l ON l.id = f.lot_id'));
  assert.deepEqual(queries[0].params, [42]);
  assert(!queries[0].sql.includes('SELECT *'));
});

test('summary gets exact counts for visible favorites and all unread hits sequentially per owner', async () => {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  let running = 0, maximum = 0;
  const query: AccountContextQuery = async (sql, params) => {
    running++;
    maximum = Math.max(maximum, running);
    queries.push({ sql, params });
    await Promise.resolve();
    running--;
    if (sql.includes('FROM favorites')) return [{ count: 17 }];
    return [{ count: 31 }]; // deliberately larger than one page of hits
  };
  const result = await createAccountContext(query).summarize(9);
  assert.deepEqual(result, { favoriteCount: 17, unreadAlertCount: 31 });
  assert.equal(maximum, 1, 'query failure/ordering barrier must remain sequential');
  assert.equal(queries.length, 2);
  assert(queries[1].sql.includes('FROM alert_hits h'));
  assert(queries[1].sql.includes('JOIN alerts a ON a.id = h.alert_id'));
  assert(queries[1].sql.includes('WHERE a.owner_id = $1 AND NOT h.seen'));
  assert.deepEqual(queries.map((q) => q.params), [[9], [9]]);
});

test('decorator parameterizes distinct IDs, preserves order and overwrites stale flags per owner', async () => {
  const seen: Array<{ owner: number; ids: number[] }> = [];
  const query: AccountContextQuery = async (_sql, params) => {
    const owner = params![0] as number;
    const ids = params![1] as number[];
    seen.push({ owner, ids });
    const membership = owner === 1 ? new Set([101]) : new Set([102]);
    return ids.filter((id) => membership.has(id)).map((lot_id) => ({ lot_id }));
  };
  const ctx = createAccountContext(query);
  const source = [lot(101, false), lot(102, true), lot(101, false)];
  const one = await ctx.decorateLots(1, source);
  const two = await ctx.decorateLots(2, source);
  assert.deepEqual(one.map((x) => [x.id, x.favorited]), [[101, true], [102, false], [101, true]]);
  assert.deepEqual(two.map((x) => [x.id, x.favorited]), [[101, false], [102, true], [101, false]]);
  assert.deepEqual(seen, [{ owner: 1, ids: [101, 102] }, { owner: 2, ids: [101, 102] }]);
  assert.equal(source[0].favorited, false, 'source rows are not mutated');
});

test('empty lists avoid queries; 100 IDs accepted, over-bound and invalid IDs rejected', async () => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const ctx = createAccountContext(async (sql, params) => { calls.push({ sql, params }); return []; });
  assert.deepEqual(await ctx.decorateLots(1, []), []);
  assert.equal(calls.length, 0);
  const hundred = await ctx.decorateLots(1, Array.from({ length: 100 }, (_, i) => lot(i + 1)));
  assert.equal(hundred.length, 100);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [1, Array.from({ length: 100 }, (_, i) => i + 1)]);
  assert.match(calls[0].sql, /owner_id = \$1 AND lot_id = ANY\(\$2::int\[\]\)/);
  await assert.rejects(() => ctx.decorateLots(1, Array.from({ length: 101 }, (_, i) => lot(i + 1))),
    (err: unknown) => err instanceof AccountContextError && err.statusCode === 400);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    await assert.rejects(() => ctx.decorateLots(1, [lot(id)]),
      (err: unknown) => err instanceof AccountContextError && err.statusCode === 400);
  }
  assert.equal(calls.length, 1, 'invalid/oversized input performs no query');
});

test('missing, zero and unsafe account IDs fail as fixed 401 without querying or echoing IDs', async () => {
  let calls = 0;
  const ctx = createAccountContext(async () => { calls++; return []; });
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, undefined]) {
    await assert.rejects(() => ctx.summarize(id as number), (err: unknown) => {
      assert(err instanceof AccountContextError);
      assert.equal(err.statusCode, 401);
      assert.equal(err.message, 'Autenticação necessária.');
      assert(!err.message.includes(String(id)));
      return true;
    });
  }
  await assert.rejects(() => ctx.decorateLots(0, []), (err: unknown) => err instanceof AccountContextError && err.statusCode === 401);
  assert.equal(calls, 0);
});

test('summary query failure stops before the next protected query', async () => {
  let calls = 0;
  const ctx = createAccountContext(async () => { calls++; throw new Error('fixture query failure'); });
  await assert.rejects(() => ctx.summarize(3), /fixture query failure/);
  assert.equal(calls, 1);
});
