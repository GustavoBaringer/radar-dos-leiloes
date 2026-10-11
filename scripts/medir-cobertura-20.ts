import { query, pool } from '../src/core/db.js';
import fs from 'node:fs';

const beforePath = process.argv[2];
if (!beforePath) throw new Error('Uso: medir-cobertura-20 <before-snapshot.json>');
const beforeSnapshot = JSON.parse(fs.readFileSync(beforePath, 'utf8')) as {
  capturedAt: string;
  domains: string[];
  counts: Array<{ host: string; total: number; active?: number; max_lot_id?: number | null }>;
};
if (!Number.isFinite(Date.parse(beforeSnapshot.capturedAt)) || !Array.isArray(beforeSnapshot.domains) || !Array.isArray(beforeSnapshot.counts)) {
  throw new Error('snapshot antes inválido');
}

const excluded = new Set(['albuquerqueleiloes.com.br', 'leiloesbrasilpe.com.br']);
const replacement = 'leiloesbrasil.com.br';
const domains = [...new Set([...beforeSnapshot.domains, replacement])];
const beforeByHost = new Map(beforeSnapshot.counts.map(row => [row.host, row]));
const hostExpr = `CASE WHEN lower(lot_url) LIKE 'https://%' THEN substring(lot_url from 9) WHEN lower(lot_url) LIKE 'http://%' THEN substring(lot_url from 8) END`;
const counts = await query<{ host: string; total: number; active: number; max_lot_id: number | null }>(
  `WITH hosts AS (SELECT id, status, ${hostExpr} AS authority FROM lots), normalized AS (
     SELECT id, status, regexp_replace(regexp_replace(lower(split_part(split_part(split_part(authority, '/', 1), chr(63), 1), chr(35), 1)), '^www[.]', ''), ':[0-9]+$', '') AS host
     FROM hosts
   ), valid AS (SELECT * FROM normalized WHERE host ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?)([.]([a-z0-9]([a-z0-9-]*[a-z0-9])?)){1,}$')
   SELECT host, count(*)::int AS total, count(*) FILTER (WHERE status IN ('aberto','agendado'))::int AS active, max(id)::int AS max_lot_id
   FROM valid WHERE host = ANY($1) GROUP BY host`,
  [domains],
);
const afterByHost = new Map(counts.map(row => [row.host, row]));
const rows = domains.map(host => {
  const before = beforeByHost.get(host);
  const after = afterByHost.get(host);
  const category = host === replacement ? 'replacement_new' : excluded.has(host) ? 'excluded_legacy' : 'included';
  return {
    domain: host, category,
    beforeCount: before?.total ?? 0, afterCount: after?.total ?? 0,
    delta: (after?.total ?? 0) - (before?.total ?? 0),
    beforeActive: before?.active ?? null, afterActive: after?.active ?? 0,
    beforeMaxLotId: before?.max_lot_id ?? null, afterMaxLotId: after?.max_lot_id ?? null,
  };
});
const output = {
  beforeSnapshot: beforePath,
  beforeCapturedAt: beforeSnapshot.capturedAt,
  measuredAt: new Date().toISOString(),
  method: 'actual snapshot comparison; validated normalized lot_url host, no auctioneer registry join',
  rows,
  totals: Object.fromEntries(['included', 'replacement_new', 'excluded_legacy'].map(category => [
    category,
    rows.filter(row => row.category === category).reduce((sum, row) => sum + row.afterCount, 0),
  ])),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = `/tmp/opencode/radar-revisao-publica/after-${stamp}.json`;
fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: outPath, ...output }));
await pool.end();
