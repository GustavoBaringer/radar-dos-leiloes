import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { query } from '../src/infra/database/query.js';
import { LotClosureRepository } from '../src/infra/database/repositories/lot-closure.repository.js';
import type { CandidatoVerificacao } from '../src/infra/database/repositories/lot-closure.repository.js';
import type { Verificador } from '../src/domain/lots/verification.js';

const FIXTURE_URL = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
if (process.env.DATABASE_URL !== FIXTURE_URL) throw new Error('Closure integration requires the exact isolated radar_prisma fixture URL.');
const mode = process.argv[2] ?? 'default';
if (mode !== 'default' && mode !== 'absence') throw new Error('mode must be default or absence');
if (mode === 'absence') {
  process.env.ENCERRAR_POR_AUSENCIA = '1';
  process.env.ENCERRAR_APOS_CICLOS = '3';
} else {
  delete process.env.ENCERRAR_POR_AUSENCIA;
}

const preflight = new pg.Client({ connectionString: FIXTURE_URL, connectionTimeoutMillis: 2000 });
await preflight.connect();
try {
  await preflight.query('BEGIN READ ONLY');
  const [{ name, lots, runs }] = (await preflight.query('SELECT current_database() AS name, (SELECT count(*) FROM lots)::int AS lots, (SELECT count(*) FROM collection_runs)::int AS runs')).rows;
  if (name !== 'radar_prisma') throw new Error(`refusing database ${name}`);
  if (lots !== 0) throw new Error(`refusing global closure SQL: fixture has ${lots} pre-existing lots; required baseline is empty`);
  if (runs !== 0) throw new Error(`refusing closure integration: fixture has ${runs} pre-existing collection runs; required baseline is empty`);
  await preflight.query('ROLLBACK');
} finally { await preflight.end(); }

const prefix = `closure-migration-${randomUUID()}`;
const sourceIds = ['soleon', `${prefix}-absence`];
const insertedSources: string[] = [];
const externalIds: string[] = [];
const runIds: number[] = [];
let context: Awaited<ReturnType<(typeof import('../src/bootstrap/collection-context.js'))['createCollectionContext']>> | undefined;
const repository = new LotClosureRepository();
const now = Date.now();
const inHours = (hours: number) => new Date(now + hours * 3_600_000);
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000);

async function ensureSource(id: string) {
  const found = await query<{ id: string }>('SELECT id FROM sources WHERE id=$1', [id]);
  if (!found.length) {
    await query('INSERT INTO sources (id,name,method,tier) VALUES ($1,$1,\'html\',1)', [id]);
    insertedSources.push(id);
  }
}

async function addLot(input: {
  source?: string; label: string; status?: string; closingModel?: string;
  start?: Date | null; end?: Date | null; collected?: Date; verified?: Date | null;
  fails?: number; result?: string | null; url?: string | null;
}): Promise<number> {
  const externalId = `${prefix}-${input.label}`;
  externalIds.push(externalId);
  const [row] = await query<{ id: number }>(`INSERT INTO lots
    (source_id,external_id,lot_url,title_raw,status,closing_model,auction_start_utc,auction_end_utc,collected_at,verified_at,verify_fails,verify_result)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [
    input.source ?? 'soleon', externalId, input.url ?? null, `fixture ${input.label}`, input.status ?? 'aberto',
    input.closingModel ?? 'timer_por_lote', input.start ?? null, input.end ?? null, input.collected ?? new Date(now),
    input.verified ?? null, input.fails ?? 0, input.result ?? null,
  ]);
  return row.id;
}

async function addRun(source: string, started: Date, limit = 1000, ok = true) {
  const [row] = await query<{ id: number }>(`INSERT INTO collection_runs (source_id,job,started_at,finished_at,ok,limite)
    VALUES ($1,'collect',$2,$2,$3,$4) RETURNING id`, [source, started, ok, limit]);
  runIds.push(row.id);
  return row.id;
}

async function checkRow(id: number) {
  const [row] = await query<any>(`SELECT status,closed_reason,verify_result,verify_fails,verified_at,auction_end_utc
    FROM lots WHERE id=$1`, [id]);
  return row;
}

async function main() {
  await ensureSource('soleon');
  await ensureSource(sourceIds[1]);

  const pastTimer = await addLot({ label: 'past-timer', end: inMinutes(-1) });
  const noEnd = await addLot({ label: 'timer-no-end', end: null });
  const pastStart = await addLot({ label: 'past-start', closingModel: 'pregao_em_horario', start: inMinutes(-1) });
  const futureStart = await addLot({ label: 'future-start', closingModel: 'pregao_em_horario', start: inHours(1) });

  let absentOld: number | undefined;
  let absentRecent: number | undefined;
  if (mode === 'absence') {
    absentOld = await addLot({ source: sourceIds[1], label: 'absence-old', end: inHours(8), collected: inMinutes(-40) });
    absentRecent = await addLot({ source: sourceIds[1], label: 'absence-recent', end: inHours(8), collected: inMinutes(-10) });
    await addRun(sourceIds[1], inMinutes(-30));
    await addRun(sourceIds[1], inMinutes(-20));
    await addRun(sourceIds[1], inMinutes(-1), 999);
  } else {
    absentOld = await addLot({ source: sourceIds[1], label: 'absence-disabled', end: inHours(8), collected: inMinutes(-40) });
    await addRun(sourceIds[1], inMinutes(-30));
    await addRun(sourceIds[1], inMinutes(-20));
    await addRun(sourceIds[1], inMinutes(-5));
  }

  const verifier: Verificador = {
    porHost: true,
    async verificar(host, lots) {
      if (host === 'throw.fixture') throw new Error('fixture host failure');
      const verdict = new Map<number, any>();
      for (const lot of lots) {
        const id = lot.externalId?.slice(prefix.length + 1);
        if (id === 'gone') verdict.set(lot.id, { veredito: 'encerrado', sinal: 'VENDIDO confirmado' });
        else if (id === 'live') verdict.set(lot.id, { veredito: 'aberto', sinal: 'Recebendo', fimUtc: inHours(2).toISOString() });
        else if (id === 'near-deadline') verdict.set(lot.id, { veredito: 'aberto', sinal: 'Recebendo', fimUtc: inHours(2).toISOString() });
        else if (id === 'null-deadline') verdict.set(lot.id, { veredito: 'aberto', sinal: 'Recebendo', fimUtc: inHours(2).toISOString() });
        else if (id === 'upcoming' || id === 'sem-data-aged') verdict.set(lot.id, { veredito: 'agendado', sinal: 'Aguarde abertura' });
      }
      return verdict;
    },
  };
  context = await (await import('../src/bootstrap/collection-context.js')).createCollectionContext({
    closure: true, closureDependencies: { repository, verifiers: { soleon: verifier } },
  });
  assert.ok(context.closure);
  const first = await context.closure!.encerrarLotes();
  assert.equal(first.porPrazo, 2, 'timer end and scheduled start close; timer without end and future start stay open');
  assert.equal(first.porAusencia, 0, mode === 'absence' ? 'two complete catalog runs are below N=3; partial is ignored' : 'absence remains disabled by default');
  assert.equal((await checkRow(pastTimer)).closed_reason, 'prazo');
  assert.equal((await checkRow(pastStart)).closed_reason, 'prazo');
  assert.equal((await checkRow(noEnd)).status, 'aberto');
  assert.equal((await checkRow(futureStart)).status, 'aberto');
  if (mode === 'default') assert.equal((await checkRow(absentOld!)).status, 'aberto', 'absence remains disabled despite three successful full scans');

  if (mode === 'absence') {
    await addRun(sourceIds[1], inMinutes(-5));
    await addRun(sourceIds[1], inMinutes(-4), 2000, false);
    const second = await context.closure!.encerrarLotes();
    assert.equal(second.porAusencia, 1, 'three successful full catalogs close only lots collected before the oldest qualifying scan');
    assert.equal((await checkRow(absentOld!)).closed_reason, 'ausente_na_fonte');
    assert.equal((await checkRow(absentRecent!)).status, 'aberto');
  }

  const completeScan = await addRun('soleon', inMinutes(-5));
  await addRun('soleon', inMinutes(-4), 999);
  await addRun('soleon', inMinutes(-3), 2000, false);
  const gone = await addLot({ label: 'gone', collected: inMinutes(-6), url: `https://same.fixture/lote/${prefix}-gone` });
  const live = await addLot({ label: 'live', collected: inMinutes(-6), url: `https://same.fixture/lote/${prefix}-live` });
  const upcoming = await addLot({ label: 'upcoming', status: 'agendado', closingModel: 'pregao_em_horario', start: inHours(2), collected: inMinutes(-6), url: `https://same.fixture/lote/${prefix}-upcoming` });
  const failed = await addLot({ label: 'failed', collected: inMinutes(-6), url: 'https://throw.fixture/lote/1' });
  const futureCollection = await addLot({ label: 'future-collection', collected: inMinutes(-1), url: 'https://same.fixture/lote/5' });
  const recentVerified = await addLot({ label: 'recent-verified', collected: inMinutes(-6), verified: inMinutes(-30), url: 'https://same.fixture/lote/6' });
  const nearDeadline = await addLot({ label: 'near-deadline', collected: inMinutes(-6), end: inHours(1.5), url: `https://same.fixture/lote/${prefix}-near-deadline` });
  const nullDeadline = await addLot({ label: 'null-deadline', collected: inMinutes(-6), end: null, url: `https://same.fixture/lote/${prefix}-live` });
  const semData = await addLot({ label: 'sem-data-aged', status: 'sem_data', start: inMinutes(-25 * 60), collected: inMinutes(-1), url: `https://same.fixture/lote/${prefix}-upcoming` });
  void completeScan;

  const verification = await context.closure!.verificarCandidatos(50);
  assert.deepEqual(verification, { verificados: 7, encerrados: 1, vivos: 5, indeterminados: 1 });
  assert.equal((await checkRow(gone)).closed_reason, 'verificado_na_fonte');
  assert.equal((await checkRow(live)).status, 'aberto');
  assert.equal((await checkRow(upcoming)).status, 'agendado');
  assert.equal((await checkRow(failed)).verify_fails, 1, 'network error per host records indeterminate/fail backoff');
  assert.equal((await checkRow(failed)).status, 'aberto', 'host errors never close lots');
  assert.equal((await checkRow(futureCollection)).verified_at, null, 'partial/latest run does not make a lot a candidate');
  assert.equal((await checkRow(recentVerified)).verified_at?.toISOString(), inMinutes(-30).toISOString(), 'verified backoff excludes recent lot');
  assert.equal((await checkRow(nearDeadline)).auction_end_utc.toISOString(), inHours(1.5).toISOString(), 'less than one-hour end difference is retained');
  assert.equal((await checkRow(nullDeadline)).auction_end_utc.toISOString(), inHours(2).toISOString(), 'null source deadline is filled');
  assert.equal((await checkRow(semData)).verify_result, 'Aguarde abertura', 'aged sem_data candidate is verified');
}

try {
  await main();
  console.log(`OK: ${mode} closure PostgreSQL integration`);
} finally {
  try {
    if (externalIds.length) await query('DELETE FROM lots WHERE source_id = ANY($1::text[]) AND external_id = ANY($2::text[])', [sourceIds, externalIds]);
    if (runIds.length) await query('DELETE FROM collection_runs WHERE id = ANY($1::bigint[])', [runIds]);
    for (const id of insertedSources) await query('DELETE FROM sources WHERE id=$1', [id]);
    if (externalIds.length) {
      const [remaining] = await query<{ lots: number; runs: number }>(`SELECT
        (SELECT count(*)::int FROM lots WHERE external_id LIKE $1)::int AS lots,
        (SELECT count(*)::int FROM collection_runs WHERE id = ANY($2::bigint[]))::int AS runs`, [`${prefix}%`, runIds]);
      assert.deepEqual(remaining, { lots: 0, runs: 0 });
    }
  } finally { await context?.close(); }
}
