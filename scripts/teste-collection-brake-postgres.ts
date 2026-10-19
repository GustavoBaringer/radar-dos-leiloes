import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const FIXTURE_URL = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
if (process.env.DATABASE_URL !== FIXTURE_URL) throw new Error('Collection brake integration requires the exact isolated radar_prisma fixture URL.');
const preflight = new pg.Client({ connectionString: FIXTURE_URL, connectionTimeoutMillis: 2000 });
await preflight.connect();
try {
  await preflight.query('BEGIN READ ONLY');
  const { rows: [{ name }] } = await preflight.query('SELECT current_database() AS name');
  if (name !== 'radar_prisma') throw new Error(`refusing database ${name}`);
  await preflight.query('ROLLBACK');
} finally { await preflight.end(); }

const [{ query, pool }, { CollectionBrakeModule }, { CollectionBrakeService }, { NestFactory }] = await Promise.all([
  import('../src/core/db.js'), import('../src/application/modules/collection-brake/collection-brake.module.js'),
  import('../src/application/services/collection/collection-brake.service.js'), import('@nestjs/core'),
]);
const id = `brake-${randomUUID()}`;
const runIds: number[] = [];
let sourceInserted = false;
let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
try {
  await query("INSERT INTO sources (id,name,method,tier) VALUES ($1,$1,'html',1)", [id]);
  sourceInserted = true;
  for (let i = 0; i < 5; i++) {
    const [row] = await query<{ id: number }>(`INSERT INTO collection_runs (source_id,job,started_at,finished_at,ok,limite)
      VALUES ($1,$2,now()-($3::text||' seconds')::interval,now()-($3::text||' seconds')::interval,false,1000) RETURNING id`, [id, i % 2 ? 'collect:cli' : 'collect', i]);
    runIds.push(row.id);
  }
  const [unfinished] = await query<{ id: number }>(`INSERT INTO collection_runs (source_id,job,started_at,finished_at,ok,limite) VALUES ($1,'collect',now()+interval '1 second',NULL,NULL,1000) RETURNING id`, [id]);
  runIds.push(unfinished.id);
  const [ignored] = await query<{ id: number }>(`INSERT INTO collection_runs (source_id,job,started_at,finished_at,ok,limite) VALUES ($1,'refresh',now()+interval '2 seconds',now()+interval '2 seconds',true,1000) RETURNING id`, [id]);
  runIds.push(ignored.id);
  app = await NestFactory.createApplicationContext(CollectionBrakeModule.forRoot(), { logger: false });
  const service = app.get(CollectionBrakeService);
  let result = await service.consultaFreio(id);
  assert.equal(result.permite, false);
  assert.equal(result.seguidas, 5);
  assert.equal((await service.fontesFreadas()).some(row => row.sourceId === id && row.seguidas === 5), true);
  const [success] = await query<{ id: number }>(`INSERT INTO collection_runs (source_id,job,started_at,finished_at,ok,limite) VALUES ($1,'collect',now()+interval '3 seconds',now()+interval '3 seconds',true,1000) RETURNING id`, [id]);
  runIds.push(success.id);
  result = await service.consultaFreio(id);
  assert.equal(result.permite, true);
  assert.equal(result.seguidas, 0);
  assert.equal((await service.fontesFreadas()).some(row => row.sourceId === id), false);
  console.log('OK: PostgreSQL brake: 5 failures + NULL blocked; ignored job excluded; success resets; source health filtered');
} finally {
  try {
    if (runIds.length) await query('DELETE FROM collection_runs WHERE source_id=$1 AND id=ANY($2::bigint[])', [id, runIds]);
    if (sourceInserted) await query('DELETE FROM sources WHERE id=$1', [id]);
    assert.deepEqual(await query('SELECT id FROM collection_runs WHERE id=ANY($1::bigint[])', [runIds]), []);
    assert.deepEqual(await query('SELECT id FROM sources WHERE id=$1', [id]), []);
  } finally {
    await app?.close();
    await pool.end();
  }
}
