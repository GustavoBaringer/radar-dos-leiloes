import assert from 'node:assert/strict';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { queryResultWithClient } from '../src/infra/database/query.js';
import { applyKussBackfill } from './backfill-kuss-lance-minimo.js';

const expectedUrl = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
const sentinel = new Error('Kuss fixture rollback sentinel');
type Plan = Parameters<typeof applyKussBackfill>[1];

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
          id bigint PRIMARY KEY, source_id text NOT NULL, min_bid numeric CHECK (min_bid IS NULL OR min_bid >= 0),
          bid_suspect boolean NOT NULL, raw jsonb NOT NULL, current_bid numeric, appraisal numeric
        )`);
        await queryResultWithClient(tx, `INSERT INTO lots VALUES
          (1,'kuss',NULL,FALSE,'{"leilaoId":"1","leId":"11"}',100,1000),
          (2,'kuss',NULL,TRUE,'{"leilaoId":"2","leId":"22"}',200,2000),
          (3,'kuss',50,FALSE,'{"leilaoId":"3","leId":"33"}',30,300),
          (4,'other',NULL,TRUE,'{"leilaoId":"4","leId":"44"}',400,4000)`);
        const plan: Plan = [
          { before: { id: 1, leilao: '1', le_id: '11', min_bid: null, current_bid: 100, appraisal: 1000, bid_suspect: false }, minBid: 120, bidSuspect: false },
          { before: { id: 2, leilao: '2', le_id: '22', min_bid: null, current_bid: 199, appraisal: 2000, bid_suspect: true }, minBid: 250, bidSuspect: false },
          { before: { id: 3, leilao: '3', le_id: '33', min_bid: 50, current_bid: 30, appraisal: 300, bid_suspect: false }, minBid: 60, bidSuspect: true },
          { before: { id: 4, leilao: '4', le_id: '44', min_bid: null, current_bid: 400, appraisal: 4000, bid_suspect: true }, minBid: 450, bidSuspect: false },
        ];
        await queryResultWithClient(tx, 'SAVEPOINT before_apply');
        assert.equal(await applyKussBackfill(tx, plan), 1);
        const rows = (await queryResultWithClient<any>(tx, 'SELECT id,min_bid,bid_suspect FROM lots ORDER BY id')).rows;
        assert.deepEqual(rows.map((r:any) => [r.id,r.min_bid,r.bid_suspect]), [[1,120,false],[2,null,true],[3,50,false],[4,null,true]]);
        assert.equal(await applyKussBackfill(tx, plan), 0, 'repeat é idempotente');
        await queryResultWithClient(tx, 'ROLLBACK TO SAVEPOINT before_apply');
        assert.equal((await queryResultWithClient<any>(tx, 'SELECT min_bid FROM lots WHERE id=1')).rows[0].min_bid, null);
        throw sentinel;
      }, { maxWait: 5000, timeout: 300000 });
    } catch (error) {
      if (error !== sentinel) throw error;
    }
    const post = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM public.lots`);
    assert.equal(post[0].n, baseline, 'lots público permaneceu inalterado');
    console.log(`OK: applyKussBackfill real gravou 1, deixou CAS/min_bid/source_id intactos nos demais e repetição gravou 0; rollback externo preservou public.lots=${baseline}. TEMP isolada na conexão transacional; import sem executar CLI ou HTTP.`);
  } finally {
    await PrismaService.disconnectInstance();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
