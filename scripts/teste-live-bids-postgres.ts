import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const FIXTURE_URL = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
if (process.env.DATABASE_URL !== FIXTURE_URL) throw new Error('Live bids integration requires the exact isolated radar_prisma fixture URL.');

const preflight = new pg.Client({ connectionString: FIXTURE_URL, connectionTimeoutMillis: 2000 });
await preflight.connect();
try {
  await preflight.query('BEGIN READ ONLY');
  const { rows: [{ name }] } = await preflight.query('SELECT current_database() AS name');
  if (name !== 'radar_prisma') throw new Error(`refusing database ${name}`);
  await preflight.query('ROLLBACK');
} finally { await preflight.end(); }

const [{ query }, { LiveBidsModule }, { LiveBidsService }, { lotesQuentes }, lotsRepo, { NestFactory }] = await Promise.all([
  import('../src/core/db.js'), import('../src/application/modules/live-bids/live-bids.module.js'),
  import('../src/application/services/live-bids/live-bids.service.js'), import('../src/infra/database/repositories/live-bids.repository.js'),
  import('../src/infra/database/repositories/lots.repository.js'), import('@nestjs/core'),
]);
const prefix = `live-bids-${randomUUID()}`;
const sourceId = prefix;
let lotId: number | undefined;
let sourceInserted = false;
let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
const future = new Date(Date.now() + 5 * 60_000);
const extension = new Date(future.getTime() + 60_000);
try {
  await query("INSERT INTO sources (id,name,method,tier) VALUES ($1,$1,'html',1)", [sourceId]);
  sourceInserted = true;
  const [lot] = await query<{id:number}>(`INSERT INTO lots
    (source_id,external_id,lot_url,title_raw,status,closing_model,auction_end_utc,collected_at,verify_fails)
    VALUES ($1,$2,NULL,$3,'aberto','timer_por_lote',$4,now(),0) RETURNING id`, [sourceId, prefix, 'live bids fixture', future]);
  lotId = lot.id;
  const changes: string[] = [];
  const module = LiveBidsModule.forRoot({ lotesQuentes, leitores: { [sourceId]: async () => ({ lance: 120, fim: extension }) }, registrarLeituraAoVivo: lotsRepo.registrarLeituraAoVivo, publicar: async payload => { changes.push(payload); }, sleep: async () => {} });
  app = await NestFactory.createApplicationContext(module, { logger: false });
  const service = app.get(LiveBidsService);
  assert.equal((await lotesQuentes([sourceId])).some(l => l.id === lotId), true);
  await service.ciclo();
  const [stored] = await query<any>('SELECT current_bid,auction_end_utc FROM lots WHERE id=$1', [lotId]);
  const history = await query<any>('SELECT bid FROM bid_history WHERE lot_id=$1', [lotId]);
  assert.equal(Number(stored.current_bid), 120);
  assert.equal(new Date(stored.auction_end_utc).toISOString(), extension.toISOString());
  assert.deepEqual(history.map(row => Number(row.bid)), [120]);
  assert.equal(changes.length, 1);
  assert.deepEqual(JSON.parse(changes[0]), { type: 'bids', changes: [{ lotId, sourceId, externalId: prefix, title: 'live bids fixture', oldBid: null, newBid: 120 }] });
  console.log('OK: live bids PostgreSQL integration (1 hot lot, bid/history persisted, end extended, 1 publication)');
} finally {
  try {
    if (lotId) {
      await query('DELETE FROM bid_history WHERE lot_id=$1', [lotId]);
      await query('DELETE FROM lots WHERE id=$1 AND source_id=$2', [lotId, sourceId]);
      assert.deepEqual(await query('SELECT id FROM lots WHERE id=$1', [lotId]), []);
    }
    if (sourceInserted) await query('DELETE FROM sources WHERE id=$1', [sourceId]);
  } finally {
    await app?.close();
    const { pool } = await import('../src/core/db.js');
    await pool.end();
  }
}
