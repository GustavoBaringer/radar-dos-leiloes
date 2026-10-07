import assert from 'node:assert/strict';
import test from 'node:test';
import { dueTenants, loadTenantAttempts, selectDue } from '../src/connectors/tenant-scheduler.js';
import { rotateTenants } from '../src/connectors/tenant-rotation.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const h = (n: number) => new Date(NOW.getTime() - n * 3600_000);

test('selectDue: nunca tentados primeiro, depois concluídos antigos, depois não-concluídos velhos', () => {
  const rows = [
    { domain: 'done-old.br', state: 'completed', started_at: h(50), finished_at: h(49) },
    { domain: 'done-new.br', state: 'completed', started_at: h(10), finished_at: h(9) },
    { domain: 'failed-stale.br', state: 'failed', started_at: h(30), finished_at: h(30) },
    { domain: 'running-fresh.br', state: 'running', started_at: h(1), finished_at: null },
  ];
  const order = selectDue(['done-new.br', 'never.br', 'failed-stale.br', 'done-old.br', 'running-fresh.br'], rows, 5, NOW);
  assert.deepEqual(order, ['never.br', 'done-old.br', 'done-new.br', 'failed-stale.br', 'running-fresh.br']);
});

test('selectDue: partial recente (<6h) é adiado; running órfão antigo volta a ser due', () => {
  const rows = [
    { domain: 'partial-fresh.br', state: 'partial', started_at: h(2), finished_at: h(2) },
    { domain: 'running-dead.br', state: 'running', started_at: h(48), finished_at: null },
    { domain: 'partial-stale.br', state: 'partial', started_at: h(20), finished_at: h(20) },
  ];
  const order = selectDue(['partial-fresh.br', 'running-dead.br', 'partial-stale.br'], rows, 3, NOW);
  assert.deepEqual(order, ['running-dead.br', 'partial-stale.br', 'partial-fresh.br']);
});

test('selectDue: normaliza www/ponto/caixa, deduplica, respeita limit e candidatos vazios', () => {
  assert.deepEqual(selectDue(['WWW.A.com.', 'a.com', ' b.br '], [], 9, NOW), ['a.com', 'b.br']);
  assert.deepEqual(selectDue(['a.com', 'b.com', 'c.com'], [], 2, NOW), ['a.com', 'b.com']);
  assert.deepEqual(selectDue([], [], 5, NOW), []);
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => selectDue(['a.com'], [], limit, NOW), RangeError);
  }
});

test('dueTenants: track desligado nem toca o ledger (comportamento = rotação clássica)', async () => {
  let called = 0;
  const selected = await dueTenants({
    sourceId: 'soleon', candidates: ['a.com', 'b.com', 'c.com'], limit: 2, now: NOW, track: false,
    execute: async () => { called++; return []; },
  });
  assert.equal(called, 0);
  assert.deepEqual(selected, rotateTenants(['a.com', 'b.com', 'c.com'], 2, NOW));
});

test('dueTenants: ledger ligado consulta por sourceId e seleciona pela última tentativa', async () => {
  const seen = { sql: '', params: [] as any[] };
  const selected = await dueTenants({
    sourceId: 'leilotech', candidates: ['www.a.com', 'b.com', 'c.com'], limit: 2, now: NOW, track: true,
    execute: async (sql, params) => {
      seen.sql = sql; seen.params = params ?? [];
      return [{ domain: 'a.com', started_at: h(40), state: 'completed', finished_at: h(39) }];
    },
  });
  assert.match(seen.sql, /DISTINCT ON \(lower\(trim\(domain\)\)\)/);
  assert.match(seen.sql, /FROM tenant_collection_attempts/);
  assert.deepEqual(seen.params, ['leilotech']);
  assert.deepEqual(selected, ['b.com', 'c.com']);
});

test('dueTenants: falha do ledger cai para rotação clássica com warning (TENANT_DUE_FALLBACK padrão)', async () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const selected = await dueTenants({
      sourceId: 'sishp', candidates: ['a.com', 'b.com', 'c.com'], limit: 2, now: NOW, track: true,
      execute: async () => { throw new Error('relation does not exist'); },
    });
    assert.deepEqual(selected, rotateTenants(['a.com', 'b.com', 'c.com'], 2, NOW));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
  }
});

test('dueTenants: TENANT_DUE_FALLBACK=0 propaga o erro do ledger', async () => {
  process.env.TENANT_DUE_FALLBACK = '0';
  try {
    await assert.rejects(
      dueTenants({ sourceId: 'sishp', candidates: ['a.com'], limit: 1, now: NOW, track: true, execute: async () => { throw new Error('boom'); } }),
      /boom/,
    );
  } finally {
    delete process.env.TENANT_DUE_FALLBACK;
  }
});

test('loadTenantAttempts: normaliza domínio e datas do Postgres/strings', async () => {
  const rows = await loadTenantAttempts('vlance', async () => [
    { domain: 'WWW.Exemplo.COM.', started_at: '2026-10-07T10:00:00Z', state: 'completed', finished_at: '2026-10-07T10:05:00Z' },
    { domain: '', started_at: null, state: null, finished_at: null },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'exemplo.com');
  assert.ok(rows[0].started_at instanceof Date);
  assert.ok(rows[0].finished_at instanceof Date);
});
