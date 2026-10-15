import assert from 'node:assert/strict';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { queryResultWithClient } from '../src/infra/database/query.js';
import { applyReconciliation, TARGETS } from './reconciliar-dominios-fenaju.js';

const expectedUrl = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
const sentinel = new Error('fixture transaction rollback sentinel');
const fields = 'id, registry, external_id, name, matricula, junta, uf, uf_junta, domain, domain_origin, blocked, situacao';

async function main() {
  assert.equal(process.env.DATABASE_URL, expectedUrl, 'DATABASE_URL deve ser exatamente o fixture local');
  const prisma = PrismaService.getInstance();
  try {
    await prisma.$connect();
    const preflight = await prisma.$queryRawUnsafe<any[]>(`SELECT current_database() AS db, (SELECT count(*)::int FROM public.auctioneers) AS n`);
    assert.deepEqual(preflight[0], { db: 'radar_prisma', n: 0 }, 'fixture deve ser radar_prisma com tabela pública vazia');
    const baseline = preflight[0].n;
    try {
      await prisma.$transaction(async tx => {
        await queryResultWithClient(tx, `CREATE TEMP TABLE auctioneers (
          id bigint PRIMARY KEY, registry text NOT NULL, external_id text NOT NULL, name text NOT NULL,
          matricula text, junta text, uf text, uf_junta text, domain text, domain_origin text,
          blocked boolean NOT NULL, situacao text NOT NULL, UNIQUE(domain)
        )`);
        await queryResultWithClient(tx, `CREATE TEMP TABLE discovered_sites (
          domain text PRIMARY KEY, auctioneers integer NOT NULL, ufs text[], http_status integer,
          has_lots boolean, platform text, connector_id text, title text, checked_at timestamptz, note text
        )`);
        await queryResultWithClient(tx, `INSERT INTO auctioneers (${fields})
          SELECT g, 'fixture', 'external-' || g, 'filler-' || g, NULL, NULL, NULL, NULL,
            NULL, NULL, FALSE, 'Regular' FROM generate_series(1,1947) g
          WHERE g NOT IN ($1,$2)`, [TARGETS[0].id, TARGETS[1].id]);
        await queryResultWithClient(tx, `UPDATE auctioneers SET domain='filler-' || id || '.invalid'
          WHERE id IN (SELECT id FROM auctioneers WHERE id NOT IN ($1,$2) ORDER BY id LIMIT 1193)`,
          [TARGETS[0].id, TARGETS[1].id]);
        for (const t of TARGETS) await queryResultWithClient(tx,
          `INSERT INTO auctioneers (${fields}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,FALSE,'Regular')`,
          [t.id,t.registry,t.external_id,t.name,t.matricula,t.junta,t.uf,t.uf_junta]);
        const seeded = (await queryResultWithClient<any>(tx, `SELECT count(*)::int total, count(*) FILTER (WHERE domain IS NOT NULL)::int com_domain FROM auctioneers`)).rows[0];
        assert.deepEqual(seeded, { total: 1947, com_domain: 1193 });
        const prior = TARGETS[0];
        await queryResultWithClient(tx, `INSERT INTO discovered_sites(domain,auctioneers,ufs,http_status,title,note)
          VALUES ($1,7,ARRAY['OLD']::text[],200,'fixture title','preserve')`, [prior.domain]);
        const siteBefore = (await queryResultWithClient<any>(tx, `SELECT domain, auctioneers, ufs, http_status, has_lots, platform, connector_id, title, checked_at, note FROM discovered_sites WHERE domain=ANY($1::text[])`, [TARGETS.map(t=>t.domain)])).rows;
        const ready = (await queryResultWithClient<any>(tx, `SELECT ${fields} FROM auctioneers WHERE id=ANY($1::bigint[]) ORDER BY id`, [TARGETS.map(t=>t.id)])).rows.map(row => ({ target: TARGETS.find(t=>t.id===row.id)!, row }));
        await queryResultWithClient(tx, 'SAVEPOINT before_apply');
        const result = await applyReconciliation(tx, ready, seeded, siteBefore);
        assert.equal(result.afterCounts.total, 1947);
        assert.equal(result.afterCounts.com_domain, 1195);
        assert.equal(result.afterSites.find((r:any)=>r.domain===prior.domain).title, 'fixture title');
        await queryResultWithClient(tx, 'ROLLBACK TO SAVEPOINT before_apply');
        await queryResultWithClient(tx, `UPDATE auctioneers SET name='concurrent' WHERE id=$1`, [TARGETS[1].id]);
        await queryResultWithClient(tx, 'SAVEPOINT before_cas');
        await assert.rejects(applyReconciliation(tx, ready, seeded, siteBefore), /compare-and-set falhou/);
        await queryResultWithClient(tx, 'ROLLBACK TO SAVEPOINT before_cas');
        assert.equal((await queryResultWithClient<any>(tx, 'SELECT domain FROM auctioneers WHERE id=$1', [TARGETS[0].id])).rows[0].domain, null);
        throw sentinel;
      }, { maxWait: 5000, timeout: 300000 });
    } catch (error) {
      if (error !== sentinel) throw error;
    }
    const after = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM public.auctioneers`);
    assert.equal(after[0].n, baseline, 'fixture público permaneceu inalterado');
    console.log('OK: apply real 1947/1193→1947/1195, metadados preservados, CAS falha no segundo alvo e savepoint; rollback externo manteve public.auctioneers=0. TEMP isolada na conexão transacional.');
  } finally {
    await PrismaService.disconnectInstance();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
