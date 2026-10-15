import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { queryResultWithClient } from '../src/infra/database/query.js';
import { applyClassificationBackfill, fingerprint, revertClassificationBackfill } from './backfill-classificacao-filtros.js';

const expectedUrl = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
const sentinel = new Error('classification fixture rollback sentinel');
const dir = await mkdtemp(join(tmpdir(), 'classification-prisma-'));
const backupPath = join(dir, 'backup.json');

async function main() {
  assert.equal(process.env.DATABASE_URL, expectedUrl, 'DATABASE_URL deve ser exatamente o fixture local');
  const prisma = PrismaService.getInstance();
  try {
    await prisma.$connect();
    const pre = await prisma.$queryRawUnsafe<any[]>(`SELECT current_database() AS db, (SELECT count(*)::int FROM public.lots) AS n`);
    assert.equal(pre[0].db, 'radar_prisma');
    const baseline = pre[0].n;
    try {
      await prisma.$transaction(async tx => {
        await queryResultWithClient(tx, `CREATE TEMP TABLE lots (
          id bigint PRIMARY KEY, source_id text NOT NULL, external_id text, asset_type text NOT NULL,
          vehicle_type text, doc_type text, title_raw text NOT NULL, source_category text, raw jsonb
        )`);
        await queryResultWithClient(tx, `INSERT INTO lots VALUES
          (1,'vlance','e1','veiculo','carro',NULL,'Honda moto',NULL,'{}'),
          (2,'leilo','e2','veiculo','suv',NULL,'Caminhão',NULL,'{}'),
          (3,'vlance','e3','veiculo','picape',NULL,'Moto',NULL,'{}')`);
        const rows = (await queryResultWithClient<any>(tx, `SELECT id,source_id,external_id,asset_type,vehicle_type,doc_type,title_raw,source_category,raw FROM lots ORDER BY id`)).rows;
        const changes = rows.slice(0, 2).map((r:any, i:number) => ({ id:r.id, source:r.source_id, externalId:r.external_id,
          field:'vehicle_type' as const, before:r.vehicle_type, after:i===0?'moto':'caminhao',
          evidence:{origin:'fixture',rule:'test'}, fingerprint:fingerprint(r) }));
        changes[1] = { ...changes[1], fingerprint:'0'.repeat(64) };
        const result = await applyClassificationBackfill(tx, changes, backupPath);
        assert.equal(result.changed, 1);
        assert.equal(result.skippedConcurrent, 1);
        const backup = JSON.parse(await readFile(backupPath, 'utf8'));
        assert.equal(backup.changes.length, 1);
        assert.equal(backup.changes[0].before, 'carro');
        assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
        await queryResultWithClient(tx, `UPDATE lots SET vehicle_type='suv' WHERE id=1`);
        const reverted = await revertClassificationBackfill(tx, backup);
        assert.deepEqual(reverted, { restored: 0, skipped: 1 });
        throw sentinel;
      }, { maxWait: 5000, timeout: 300000 });
    } catch (error) { if (error !== sentinel) throw error; }
    // A failed backup write must abort before any fixture update can persist.
    await assert.rejects(prisma.$transaction(async tx => {
      await queryResultWithClient(tx, `CREATE TEMP TABLE lots (
        id bigint PRIMARY KEY, source_id text NOT NULL, external_id text, asset_type text NOT NULL,
        vehicle_type text, doc_type text, title_raw text NOT NULL, source_category text, raw jsonb
      )`);
      await queryResultWithClient(tx, `INSERT INTO lots VALUES (1,'vlance','e1','veiculo','carro',NULL,'moto',NULL,'{}')`);
      const row = (await queryResultWithClient<any>(tx, `SELECT id,source_id,external_id,asset_type,vehicle_type,doc_type,title_raw,source_category,raw FROM lots`)).rows[0];
      const change = { id:1, source:'vlance', externalId:'e1', field:'vehicle_type' as const, before:'carro', after:'moto', evidence:{origin:'fixture',rule:'test'}, fingerprint:fingerprint(row) };
      await applyClassificationBackfill(tx, [change], '/dev/null/classification-backup.json');
      throw sentinel;
    }, { maxWait: 5000, timeout: 300000 }), /EEXIST|ENOTDIR/);
    const post = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM public.lots`);
    assert.equal(post[0].n, baseline);
    console.log(`OK: apply/revert reais; changed=1 skippedConcurrent=1, backup pré-valor mode=0600, revert concurrent skipped=1, backup failure abortou a transação; public.lots=${baseline}. SELECT ... FOR UPDATE executado; sem teste de concorrência simultânea. Import sem CLI/fetch.`);
  } finally {
    await PrismaService.disconnectInstance();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
