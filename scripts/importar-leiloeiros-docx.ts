/**
 * Importa listas de leiloeiros em DOCX (extraídas previamente pelo operador para
 * texto simples) e sonda os domínios. Uso:
 *
 *   node --env-file=.env --import tsx scripts/importar-leiloeiros-docx.ts \
 *     /tmp/opencode/leiloeiros_txt
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query } from '../src/core/db.js';
import { sondarDominios } from '../src/core/descoberta.js';
import { ensureSources } from '../src/core/repo.js';

type Row = Record<string, any>;

function ufDoArquivo(nome: string): string | null {
  const n = nome.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
  if (n.includes('RONDONIA')) return 'RO';
  if (n.includes('SANTA_CATARINA')) return 'SC';
  if (n.includes('MATO_GROSSO_DO_SUL')) return 'MS';
  if (n.includes('MATO_GROSSO')) return 'MT';
  if (n.includes('PARANA')) return 'PR';
  if (n.includes('RIO_GRANDE_DO_SUL')) return 'RS';
  return null;
}

function normaliza(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[),.;]+$/g, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  // E-mail em domínio próprio (ex.: marcia.nunes@vipleiloes.com.br) vira host.
  if (s.includes('@')) return null;
  return s;
}

function extraiDominios(texto: string): string[] {
  const out = new Set<string>();
  const re = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s)]*)?/gi;
  for (const m of texto.matchAll(re)) {
    const d = normaliza(m[0]);
    if (d) out.add(d);
  }
  return [...out];
}

async function report(dominios: string[]) {
  const rows = await query<Row>(
    `SELECT domain, http_status, has_lots, platform, connector_id, title, note
       FROM discovered_sites
      WHERE domain = ANY($1::text[])
      ORDER BY domain`,
    [dominios],
  );
  const resumo = await query<Row>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE http_status = 200)::int AS http_200,
            count(*) FILTER (WHERE has_lots = true)::int AS has_lots,
            count(*) FILTER (WHERE platform IS NOT NULL)::int AS with_platform,
            count(*) FILTER (WHERE connector_id IS NOT NULL)::int AS with_connector,
            count(*) FILTER (WHERE platform IS NULL AND has_lots = true)::int AS has_lots_sem_platform,
            count(*) FILTER (WHERE platform IS NOT NULL AND connector_id IS NULL)::int AS platform_sem_connector
       FROM discovered_sites
      WHERE domain = ANY($1::text[])`,
    [dominios],
  );
  const plataformas = await query<Row>(
    `SELECT coalesce(platform, '(sem plataforma)') AS platform, count(*)::int AS total,
            count(*) FILTER (WHERE has_lots = true)::int AS has_lots,
            count(*) FILTER (WHERE connector_id IS NOT NULL)::int AS connector
       FROM discovered_sites
      WHERE domain = ANY($1::text[])
      GROUP BY 1 ORDER BY total DESC, platform`,
    [dominios],
  );
  const pendentes = rows.filter((r) => r.has_lots === true && !r.connector_id);
  return { resumo: resumo[0], plataformas, pendentes };
}

async function main() {
  const dir = process.argv[2] ?? '/tmp/opencode/leiloeiros_txt';
  const arquivos = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());

  await ensureSources();
  const porDominio = new Map<string, Set<string>>();
  for (const arq of arquivos) {
    const uf = ufDoArquivo(arq) ?? '??';
    const texto = readFileSync(arq, 'utf8');
    for (const d of extraiDominios(texto)) {
      const ufs = porDominio.get(d) ?? new Set<string>();
      ufs.add(uf);
      porDominio.set(d, ufs);
    }
  }

  const dominios = [...porDominio.keys()].sort();
  for (const [domain, ufs] of porDominio) {
    await query(
      `INSERT INTO discovered_sites (domain, auctioneers, ufs, note)
       VALUES ($1, $2, $3, 'importado de DOCX estaduais em ' || now()::date)
       ON CONFLICT (domain) DO UPDATE SET
         auctioneers = GREATEST(discovered_sites.auctioneers, EXCLUDED.auctioneers),
         ufs = (SELECT array_agg(DISTINCT x ORDER BY x)
                  FROM unnest(coalesce(discovered_sites.ufs, '{}'::text[]) || EXCLUDED.ufs) AS x),
         note = coalesce(discovered_sites.note, EXCLUDED.note)`,
      [domain, ufs.size, [...ufs]],
    );
  }

  const sonda = await sondarDominios(dominios, Number(process.argv[3] ?? 10));
  console.log(JSON.stringify({ arquivos: arquivos.length, dominios: dominios.length, sonda, ...(await report(dominios)) }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}
