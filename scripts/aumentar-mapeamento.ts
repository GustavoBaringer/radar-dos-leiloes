/**
 * Pipeline operacional para aumentar a conversão:
 * catálogo oficial -> discovered_sites -> plataforma -> conector -> leiloeiros no site.
 *
 * Modos:
 *   official-missing  insere e sonda domínios oficiais ainda ausentes do discovered_sites
 *   backlog          re-sonda o estoque prioritário sem plataforma
 *   report           imprime o funil atual e os próximos alvos
 *   all              executa official-missing, backlog e report
 */
import { pool, query } from '../src/core/db.js';
import { sondarDominios } from '../src/core/descoberta.js';
import { ensureSources } from '../src/core/repo.js';

type Row = Record<string, any>;

async function oficiaisFaltantes() {
  return query<Row>(
    `WITH candidatos AS (
       SELECT
         name,
         uf_junta AS uf,
         regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(nullif(domain, ''), nullif(dominio_leilao, ''))), '^https?://', ''),
             '^www\\.', ''
           ),
           '/.*$', ''
         ) AS domain
       FROM auctioneers
       WHERE coalesce(domain, '') <> '' OR coalesce(dominio_leilao, '') <> ''
     ), limpos AS (
       SELECT name, uf, domain
       FROM candidatos
       WHERE domain ~ '^[a-z0-9.-]+\\.[a-z]{2,}$'
     ), faltantes AS (
       SELECT domain,
              count(*)::int AS auctioneers,
              array_remove(array_agg(DISTINCT upper(left(uf, 2))), NULL) AS ufs,
              array_agg(name ORDER BY name) AS names
       FROM limpos l
       WHERE NOT EXISTS (
         SELECT 1 FROM discovered_sites ds
         WHERE ds.domain = l.domain
            OR ds.domain = 'www.' || l.domain
            OR regexp_replace(ds.domain, '^www\\.', '') = l.domain
       )
       GROUP BY domain
     )
     INSERT INTO discovered_sites (domain, auctioneers, ufs, note)
     SELECT domain, auctioneers, ufs, 'inserido do catálogo oficial em ' || now()::date
     FROM faltantes
     ON CONFLICT (domain) DO UPDATE SET
       auctioneers = EXCLUDED.auctioneers,
       ufs = EXCLUDED.ufs
     RETURNING domain, auctioneers, ufs`,
  );
}

async function alvosBacklog(limite: number) {
  return query<{ domain: string }>(
    `SELECT domain
       FROM discovered_sites
      WHERE platform IS NULL
      ORDER BY
        CASE
          WHEN has_lots IS TRUE THEN 0
          WHEN http_status = 200 THEN 1
          WHEN checked_at IS NULL THEN 2
          ELSE 3
        END,
        checked_at ASC NULLS FIRST,
        auctioneers DESC,
        domain
      LIMIT $1`,
    [limite],
  );
}

async function report() {
  const [funil, plataformas, proximos, leiloeiros] = await Promise.all([
    query<Row>(
      `SELECT count(*)::int AS discovered_sites,
              count(*) FILTER (WHERE http_status=200)::int AS http_200,
              count(*) FILTER (WHERE has_lots=true)::int AS has_lots,
              count(*) FILTER (WHERE platform IS NOT NULL)::int AS with_platform,
              count(*) FILTER (WHERE connector_id IS NOT NULL)::int AS with_connector,
              count(*) FILTER (WHERE platform IS NULL)::int AS without_platform,
              count(*) FILTER (WHERE platform IS NULL AND http_status=200)::int AS unknown_http_200,
              count(*) FILTER (WHERE platform IS NULL AND has_lots=true)::int AS unknown_has_lots
         FROM discovered_sites`,
    ),
    query<Row>(
      `SELECT coalesce(platform, '(sem plataforma)') AS platform,
              count(*)::int AS total,
              count(*) FILTER (WHERE http_status=200)::int AS ok,
              count(*) FILTER (WHERE has_lots=true)::int AS has_lots,
              count(*) FILTER (WHERE connector_id IS NOT NULL)::int AS connector
         FROM discovered_sites
        GROUP BY 1 ORDER BY total DESC LIMIT 20`,
    ),
    query<Row>(
      `SELECT domain, http_status, has_lots, title, note
         FROM discovered_sites
        WHERE platform IS NULL AND (has_lots IS TRUE OR http_status = 200)
        ORDER BY CASE WHEN has_lots IS TRUE THEN 0 ELSE 1 END, auctioneers DESC, domain
        LIMIT 50`,
    ),
    query<Row>(
      `SELECT count(DISTINCT auctioneer_name)::int AS ativos_no_site
         FROM lots
        WHERE auctioneer_name IS NOT NULL
          AND auctioneer_name <> ''
          AND status IN ('aberto','agendado','sem_data')`,
    ),
  ]);
  return { funil: funil[0], leiloeiros: leiloeiros[0], plataformas, proximos };
}

async function main() {
  const modo = process.argv[2] ?? 'report';
  const limite = Number(process.argv[3] ?? 60);

  await ensureSources();

  if (modo === 'official-missing' || modo === 'all') {
    const inseridos = await oficiaisFaltantes();
    console.log(JSON.stringify({ etapa: 'official-missing', inseridos }, null, 2));
    if (inseridos.length) {
      const r = await sondarDominios(inseridos.map((r) => r.domain), 4);
      console.log(JSON.stringify({ etapa: 'sonda-official-missing', resultado: r }, null, 2));
    }
  }

  if (modo === 'backlog' || modo === 'all') {
    const alvos = await alvosBacklog(limite);
    const r = await sondarDominios(alvos.map((a) => a.domain), 6);
    console.log(JSON.stringify({ etapa: 'backlog', alvos: alvos.length, resultado: r }, null, 2));
  }

  if (modo === 'report' || modo === 'all') {
    console.log(JSON.stringify(await report(), null, 2));
  }
}

try {
  await main();
} finally {
  await pool.end();
}
