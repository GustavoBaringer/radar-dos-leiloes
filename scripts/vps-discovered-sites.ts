/**
 * Ajusta `discovered_sites` na VPS para a agenda diária enxergar os sites que
 * já têm catálogo coletado. Idempotente: pode rodar quantas vezes quiser.
 *
 *   node --env-file=.env --import tsx scripts/vps-discovered-sites.ts
 *
 * Não precisa de psql nem de DBeaver — usa o mesmo `query` do projeto e o
 * `DATABASE_URL` que o worker já consome.
 */
import { query, pool } from '../src/core/db.js';
import { FOLLOWUP_TENANTS } from '../src/connectors/suporteleiloes.js';
import { VIPLEILOES_DOMAINS } from '../src/connectors/vipleiloes.js';
import { TENANT_COVERAGE } from '../src/queue/tenant-coverage.js';

const ALVOS = [
  'lancecertoleiloes.com.br', 'leiloesfreire.com.br', 'cassianoleiloes.com.br',
  'gracieleiloes.com.br', 'leilaopernambuco.com.br', 'rjleiloes.com.br',
  'ghvmleiloes.com.br', 'inovaleilao.com.br', 'flaviocostaleiloes.com.br',
  'aragaoleiloes.com.br', 'coliseumleiloes.com.br', 'jdleiloes.com.br',
  'albuquerqueleiloes.com.br', 'portaldosleiloes.com.br', 'ericosobral.com.br',
  'colodeteleiloes.com.br', 'joserodovalholeiloes.com.br', 'leiloesbrasilpe.com.br',
  'patiorochaleiloes.com.br', 'vlleiloes.com.br', 'realizaleiloes.com.br',
  'c3leiloes.com.br', 'abaleiloes.com.br', 'lancese.com.br',
  'argleiloes.com.br', 'marcotulioleiloes.com.br', 'leiloescostaesilva.com.br',
  'tbaracajuleiloes.com.br', 'fabiobarbosaleiloes.com.br', 'leiloespb.com.br',
  'colossoleiloes.com.br', 'atlanticoleiloes.com.br', 'maglianoleiloes.com.br',
  'leiloesmonteiro.com.br', 'focoleiloes.com.br', 'celsocunhaleiloes.com.br',
  'ccjleiloes.com.br',
];

/** Caminhos pelos quais a agenda pega o site, na ordem em que o worker usa. */
const COBERTURA = new Map<string, string>(TENANT_COVERAGE.map((t) => [t.domain, `${t.sourceId} (tenant-coverage)`]));
for (const d of FOLLOWUP_TENANTS) if (!COBERTURA.has(d)) COBERTURA.set(d, 'suporteleiloes (fixo no codigo)');
for (const d of VIPLEILOES_DOMAINS) COBERTURA.set(d, 'vipleiloes (fixo no codigo)');
COBERTURA.set('celsocunhaleiloes.com.br', 'celsocunha (fixo no codigo)');
COBERTURA.set('portaldosleiloes.com.br', 'portalpublic (fixo no codigo)');
COBERTURA.set('ghvmleiloes.com.br', 'ghvmpublic (fixo no codigo)');
COBERTURA.set('leiloesfreire.com.br', 'leiloesfreire (fixo no codigo)');

try {
  await query('BEGIN');
  // A sonda lê só a home; site que expõe lotes em outra rota dá falso negativo
  // e cai fora do filtro `has_lots IS NOT FALSE` da agenda.
  const a = await query(
    `UPDATE discovered_sites SET has_lots = true, checked_at = now()
      WHERE lower(domain) = ANY($1::text[]) AND has_lots IS NOT TRUE`,
    [['ccjleiloes.com.br', 'ricoleiloes.com.br', 'leilaopernambuco.com.br', 'lilianportugal.com.br']],
  );
  const b = await query(
    `UPDATE discovered_sites SET http_status = 200, has_lots = true, checked_at = now()
      WHERE lower(domain) = 'atlanticoleiloes.com.br' AND http_status IS DISTINCT FROM 200`,
  );
  // Ambos usam o padrão /eventos/leilao/ da plataforma Suporte.
  const c = await query(
    `INSERT INTO discovered_sites (domain, platform, http_status, has_lots, title, note)
     VALUES ('compreipgfn.com.br', 'suporte-leiloes', 200, true, 'PGFN - Compromisso',
             'lotes coletados por htmlagenda; ausente na descoberta'),
            ('aplleiloes.com.br', 'suporte-leiloes', 200, true, 'APL Leiloes',
             'lotes coletados por htmlagenda; ausente na descoberta')
     ON CONFLICT (domain) DO UPDATE
       SET has_lots = true,
           platform = COALESCE(discovered_sites.platform, 'suporte-leiloes'),
           checked_at = now()`,
  );
  await query('COMMIT');
  console.log('aplicado: has_lots=%d, atlantico=%d, inserts/updates=%d', a.length, b.length, c.length);
} catch (err) {
  await query('ROLLBACK').catch(() => {});
  console.error('falhou, transação desfeita:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await pool.end();
}

console.log('\n== Sites das listas de PE/SE/PB ==');
const ds = await query<{ domain: string; platform: string | null; http_status: number | null; has_lots: boolean | null }>(
  `SELECT domain, platform, http_status, has_lots FROM discovered_sites WHERE lower(domain) = ANY($1::text[])`,
  [ALVOS],
);
const m = new Map(ds.map((d) => [d.domain.toLowerCase(), d]));
let dentro = 0, fora = 0;
for (const d of ALVOS) {
  const x = m.get(d);
  let via = COBERTURA.get(d);
  if (!via && x && x.http_status === 200 && x.has_lots !== false) via = `${x.platform} (descoberta)`;
  if (via) dentro++; else fora++;
  console.log(
    `  ${d.padEnd(30)} ${(via ?? 'FORA DA AGENDA').padEnd(32)} ` +
      `platform=${String(x?.platform ?? '-').padEnd(16)} http=${String(x?.http_status ?? '-').padEnd(5)} lots=${x?.has_lots ?? '-'}`,
  );
}
console.log(`\ndisparam: ${dentro} | fora: ${fora}`);

console.log('\n== Tenants elegiveis por plataforma ==');
for (const r of await query<{ platform: string; n: number }>(
  `SELECT platform, count(*)::int AS n FROM discovered_sites
    WHERE http_status = 200 AND has_lots IS NOT FALSE GROUP BY platform ORDER BY n DESC`,
)) console.log(`  ${String(r.platform).padEnd(20)} ${r.n}`);

await pool.end();