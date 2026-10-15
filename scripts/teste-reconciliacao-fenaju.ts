import assert from 'node:assert/strict';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { queryResultWithClient } from '../src/infra/database/query.js';
import type { Prisma } from '../src/infra/database/generated/client.js';
import { acumulaSiteFenaju, requirePersistedFenaju } from '../src/domain/discovery/discovery.js';
import { UPSERT_AUCTIONEER_FENAJU_SQL } from '../src/infra/discovery/discovery.repository.js';
import { generateConditionalRollbackSql, TARGETS } from './reconciliar-dominios-fenaju.js';

const fixture = `
  CREATE TEMP TABLE auctioneers (
    id bigint,
    registry text NOT NULL, external_id text NOT NULL, name text NOT NULL, matricula text,
    junta text, uf text, situacao text, domain text, domain_origin text, uf_junta text,
    ano_posse text, credenciamento text, associado boolean, nivel text, dominio_leilao text, blocked boolean,
    collected_at timestamptz NOT NULL DEFAULT now(), UNIQUE (registry, external_id)
  )`;
  const params = (id: string, name: string, matricula: string, junta: string, uf: string,
    domain: string | null, origin: string | null) =>
  [id, name, matricula, junta, uf, 'Regular', domain, origin, uf, null, null, null, null];

const FIXTURE_URL = 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
if (process.env.DATABASE_URL !== FIXTURE_URL) throw new Error('Fenaju integration requires exact radar_prisma fixture URL');
const ROLLBACK_SENTINEL = new Error('fixture rollback sentinel');

async function main() {
  const prisma = PrismaService.getInstance();
  try {
    try {
      await prisma.$transaction(async client => {
    await queryResultWithClient(client, fixture);

    const insert = await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
      params('new', 'Teste', '001A', 'JUCESP', 'SP', 'new.test', 'declarado'));
    assert.equal(insert.rows[0].domain, 'new.test', 'novo registro persiste o domínio de origem');

    const normalUpdate = await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
      params('new', 'Teste atualizado', '001A', 'JUCESP', 'SP', 'updated.test', 'email'));
    assert.equal(normalUpdate.rows[0].domain, 'updated.test', 'upsert comum continua atualizando domínio');
    assert.equal((await queryResultWithClient(client, `SELECT domain_origin FROM auctioneers WHERE external_id='new'`)).rows[0].domain_origin, 'email');

    await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
      params('durable', 'Durável', '1156', 'JUCESP', 'SP', 'gspleiloes.com.br', 'reconciliado_site_fenaju'));
    const identityVariants = [
      [1, 'Nome diferente'], [2, '01156'], [3, 'JUCER'], [4, 'RJ'],
    ] as const;
    for (const [index, value] of identityVariants) {
      const incomingRow = params('durable', 'Durável', '1156', 'JUCESP', 'SP', 'incoming.test', 'declarado');
      incomingRow[index] = value;
      const rejected = await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL, incomingRow);
      assert.equal(rejected.rowCount, 0, `rejeita identidade reconciliada divergente em parâmetro ${index}`);
      const intact = (await queryResultWithClient(client, `SELECT name, matricula, junta, uf, uf_junta, domain, domain_origin FROM auctioneers WHERE external_id='durable'`)).rows[0];
      assert.deepEqual(intact, {
        name: 'Durável', matricula: '1156', junta: 'JUCESP', uf: 'SP', uf_junta: 'SP',
        domain: 'gspleiloes.com.br', domain_origin: 'reconciliado_site_fenaju',
      });
      assert.throws(() => requirePersistedFenaju(rejected.rows[0], 'durable'), /recusado/);
    }
    const incoming = [
      [null, null],
      ['mail.example', 'email'],
      ['other.example', 'declarado'],
      ['tenant.leilao.br', 'dominio_url'],
    ] as const;
    let effectiveDomain: string | null = null;
    for (const [domain, origin] of incoming) {
      const saved = await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
        params('durable', 'Durável', '1156', 'JUCESP', 'SP', domain, origin));
      assert.equal(saved.rows[0].domain, 'gspleiloes.com.br', `preserva domínio reconciliado contra ${origin ?? 'null'}`);
      effectiveDomain = saved.rows[0].domain;
      const row = (await queryResultWithClient(client, `SELECT domain_origin FROM auctioneers WHERE external_id='durable'`)).rows[0];
      assert.equal(row.domain_origin, 'reconciliado_site_fenaju');
    }

    await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
      params('empty-durable', 'Durável vazio', '2', 'JUCESP', 'SP', '', 'reconciliado_site_fenaju'));
    const recovered = await queryResultWithClient(client, UPSERT_AUCTIONEER_FENAJU_SQL,
      params('empty-durable', 'Durável vazio', '2', 'JUCESP', 'SP', 'recovered.test', 'declarado'));
    assert.equal(recovered.rows[0].domain, 'recovered.test', 'origem reconciliada sem domínio pode ser recuperada');

    // A production map receives RETURNING.domain, never the rejected incoming host.
    const sites = new Map<string, { ufs: Set<string>; n: number }>();
    acumulaSiteFenaju(sites, effectiveDomain, 'SP');
    assert.deepEqual([...sites.keys()], ['gspleiloes.com.br']);
    assert.deepEqual([...sites.get('gspleiloes.com.br')!.ufs], ['SP']);
    assert.equal(sites.has('tenant.leilao.br'), false);

    await queryResultWithClient(client, `CREATE TEMP TABLE discovered_sites (
      domain text PRIMARY KEY, auctioneers integer NOT NULL, ufs text[], http_status integer,
      has_lots boolean, platform text, connector_id text, title text, checked_at timestamptz, note text
    )`);
    const rollbackBackup = {
      targets: TARGETS.map(t => ({ target: t, row: { ...t, domain: null, domain_origin: null, blocked: false, situacao: 'Regular' } })),
      discovered_sites: TARGETS.map(t => ({ domain: t.domain, auctioneers: 2, ufs: [`OLD-${t.uf}`],
        http_status: 200, has_lots: true, platform: 'soleon', connector_id: 'soleon', title: null,
        checked_at: '2026-10-09T21:31:35.240Z', note: 'backup test' })),
    };
    for (const t of TARGETS) {
      await queryResultWithClient(client, `INSERT INTO auctioneers (id,registry,external_id,name,matricula,junta,uf,uf_junta,domain,domain_origin,blocked,situacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,'Regular')`,
      [t.id,t.registry,t.external_id,t.name,t.matricula,t.junta,t.uf,t.uf_junta,t.domain,'reconciliado_site_fenaju']);
      await queryResultWithClient(client, `INSERT INTO discovered_sites (domain,auctioneers,ufs,http_status,has_lots,platform,connector_id,checked_at,note)
        VALUES ($1,1,ARRAY[$2]::text[],200,TRUE,'soleon','soleon','2026-10-09T21:31:35.240Z','backup test')`, [t.domain,t.uf]);
    }
    const rollbackSql = generateConditionalRollbackSql(rollbackBackup);
    await queryResultWithClient(client, 'SAVEPOINT valid_rollback');
    await queryResultWithClient(client, rollbackSql);
    const reverted = await queryResultWithClient(client, `SELECT count(*)::int AS n FROM auctioneers WHERE id=ANY($1::bigint[]) AND domain IS NULL AND domain_origin IS NULL`, [TARGETS.map(t=>t.id)]);
    assert.equal(reverted.rows[0].n, 2, 'DO reverte ambos os auctioneers em bloco');
    const restoredSites = await queryResultWithClient(client, `SELECT count(*)::int AS n FROM discovered_sites WHERE auctioneers=2 AND ufs[1] LIKE 'OLD-%'`);
    assert.equal(restoredSites.rows[0].n, 2, 'DO restaura metadados anteriores dos dois sites');
    await queryResultWithClient(client, 'ROLLBACK TO SAVEPOINT valid_rollback');

    await queryResultWithClient(client, `UPDATE auctioneers SET name='edição concorrente' WHERE id=$1`, [TARGETS[1].id]);
    await queryResultWithClient(client, 'SAVEPOINT adversarial_rollback');
    await assert.rejects(queryResultWithClient(client, rollbackSql), /conditional rollback auctioneers:1271 affected 0 rows/);
    await queryResultWithClient(client, 'ROLLBACK TO SAVEPOINT adversarial_rollback');
    const untouchedRows = await queryResultWithClient(client, `SELECT count(*)::int AS n FROM auctioneers WHERE id=ANY($1::bigint[])
      AND domain_origin='reconciliado_site_fenaju' AND domain=ANY($2::text[])`,
    [TARGETS.map(t=>t.id), TARGETS.map(t=>t.domain)]);
    const untouchedSites = await queryResultWithClient(client, `SELECT count(*)::int AS n FROM discovered_sites WHERE auctioneers=1 AND ufs IN (ARRAY['SP']::text[],ARRAY['PI']::text[])`);
    assert.equal(untouchedRows.rows[0].n, 2, 'falha no segundo alvo não reverte nenhum auctioneer anterior');
    assert.equal(untouchedSites.rows[0].n, 2, 'falha no segundo alvo não reverte nenhum discovered_site');
    const signaled = (await queryResultWithClient(client, `SELECT name FROM auctioneers WHERE id=$1`, [TARGETS[1].id])).rows[0];
    assert.equal(signaled.name, 'edição concorrente', 'divergência concorrente permanece intacta');

    // Mutation check: make both CASE arms accept EXCLUDED values and prove the
    // preservation assertion detects the unsafe behavior without editing source.
    const unsafeSql = UPSERT_AUCTIONEER_FENAJU_SQL
      .replaceAll('THEN auctioneers.domain ELSE EXCLUDED.domain END', 'THEN EXCLUDED.domain ELSE EXCLUDED.domain END')
      .replaceAll('THEN auctioneers.domain_origin ELSE EXCLUDED.domain_origin END', 'THEN EXCLUDED.domain_origin ELSE EXCLUDED.domain_origin END');
    await queryResultWithClient(client, unsafeSql, params('durable', 'Durável', '1156', 'JUCESP', 'SP', null, null));
    const unsafeResult = (await queryResultWithClient(client, `SELECT domain FROM auctioneers WHERE external_id='durable'`)).rows[0].domain;
    let mutationDetected = false;
    try { assert.equal(unsafeResult, 'gspleiloes.com.br'); } catch { mutationDetected = true; }
    assert.equal(mutationDetected, true, 'teste deve detectar proteção retirada');
    console.log('OK: upsert real; identidade protegida, erro em RETURNING vazio, mapa efetivo, rollback atômico/adversarial; mutation-check detectou regressão.');
    throw ROLLBACK_SENTINEL;
      }, { maxWait: 5_000, timeout: 300_000 });
    } catch (error) {
      if (error !== ROLLBACK_SENTINEL) throw error;
    }
  } finally {
    await PrismaService.disconnectInstance();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
