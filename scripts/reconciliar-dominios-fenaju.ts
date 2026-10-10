import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/core/db.js';

const DIR = '/tmp/opencode/reconciliacao-oficiais/banco';
const ORIGIN = 'reconciliado_site_fenaju';
export const TARGETS = [
  { id: 130, registry: 'fenaju', external_id: '792', name: 'Fernando Caetano Moreira', matricula: '1156', junta: 'JUCESP', uf: 'SP', uf_junta: 'SP', domain: 'gspleiloes.com.br' },
  { id: 1271, registry: 'fenaju', external_id: '1303', name: 'Sergio Roberto Nogueira Lima', matricula: '020/21', junta: 'JUCEPI', uf: 'PI', uf_junta: 'PI', domain: 'snleiloes.com.br' },
] as const;
const FIELDS = 'id, registry, external_id, name, matricula, junta, uf, uf_junta, domain, domain_origin, blocked, situacao';
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlArray = (value: string[] | null) => value === null ? 'NULL' : `ARRAY[${value.map(quote).join(',')}]::text[]`;
const sqlValue = (value: unknown) => value == null ? 'NULL' : quote(value instanceof Date ? value.toISOString() : String(value));

export function generateConditionalRollbackSql(backup: { targets: any[]; discovered_sites: any[] }) {
  const operations: string[] = [];
  const checked = (sql: string, label: string) =>
    `${sql}; GET DIAGNOSTICS affected = ROW_COUNT; IF affected <> 1 THEN RAISE EXCEPTION 'conditional rollback % affected % rows', ${quote(label)}, affected; END IF;`;
  for (const entry of backup.targets) {
    const t = entry.target;
    const old = backup.discovered_sites.find((row: any) => row.domain === t.domain);
    const metadata = ['http_status', 'has_lots', 'platform', 'connector_id', 'title', 'checked_at', 'note'];
    const metadataGuard = (row: any) => metadata.map(k => `${k} IS NOT DISTINCT FROM ${sqlValue(row?.[k])}`).join(' AND ');
    const linked = `EXISTS (SELECT 1 FROM auctioneers a WHERE a.id=${t.id} AND a.registry=${quote(t.registry)} AND a.external_id=${quote(t.external_id)} AND a.domain=${quote(t.domain)} AND a.domain_origin=${quote(ORIGIN)} AND a.blocked=FALSE AND a.situacao ILIKE 'regular')`;
    if (old) {
      operations.push(checked(
        `UPDATE discovered_sites SET auctioneers=${sqlValue(old.auctioneers)}, ufs=${sqlArray(old.ufs)} WHERE domain=${quote(t.domain)} AND auctioneers=1 AND ufs=ARRAY[${quote(t.uf)}]::text[] AND ${metadataGuard(old)} AND ${linked}`,
        `discovered_sites:${t.domain}`,
      ));
    } else {
      operations.push(checked(
        `DELETE FROM discovered_sites WHERE domain=${quote(t.domain)} AND auctioneers=1 AND ufs=ARRAY[${quote(t.uf)}]::text[] AND ${metadataGuard(null)} AND ${linked}`,
        `discovered_sites:${t.domain}`,
      ));
    }
  }
  for (const entry of backup.targets) {
    const t = entry.target;
    const old = entry.row;
    operations.push(checked(
      `UPDATE auctioneers SET domain=${sqlValue(old.domain)}, domain_origin=${sqlValue(old.domain_origin)} WHERE id=${t.id} AND registry=${quote(t.registry)} AND external_id=${quote(t.external_id)} AND name=${quote(t.name)} AND matricula=${sqlValue(t.matricula)} AND junta=${sqlValue(t.junta)} AND uf=${sqlValue(t.uf)} AND uf_junta=${sqlValue(t.uf_junta)} AND domain=${quote(t.domain)} AND domain_origin=${quote(ORIGIN)} AND blocked=FALSE AND situacao ILIKE 'regular'`,
      `auctioneers:${t.id}`,
    ));
  }
  return `DO $rollback$ DECLARE affected integer; BEGIN\n  ${operations.join('\n  ')}\nEND $rollback$;`;
}

function targetState(row: any, t: typeof TARGETS[number]) {
  const identityMatches = row && String(row.id) === String(t.id) && row.registry === t.registry &&
    row.external_id === t.external_id && row.name === t.name && row.matricula === t.matricula &&
    row.junta === t.junta && row.uf === t.uf && row.uf_junta === t.uf_junta &&
    row.blocked === false && /regular/i.test(String(row.situacao ?? ''));
  if (!identityMatches) return 'blocked';
  if ((row.domain === null || row.domain === '') && row.domain_origin === null) return 'ready';
  if (row.domain === t.domain && row.domain_origin === ORIGIN) return 'already-applied';
  return 'blocked';
}

function checkSiteMetadata(before: any, after: any) {
  for (const field of ['http_status', 'has_lots', 'platform', 'connector_id', 'title', 'checked_at', 'note']) {
    const left = before?.[field] instanceof Date ? before[field].toISOString() : before?.[field] ?? null;
    const right = after?.[field] instanceof Date ? after[field].toISOString() : after?.[field] ?? null;
    if (left !== right) throw new Error(`metadado discovered_sites alterado: ${field}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    const counts = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE domain IS NOT NULL AND domain <> '')::int AS com_domain FROM auctioneers`)).rows[0];
    const beforeRows: any[] = [];
    for (const t of TARGETS) {
      const result = await client.query(`SELECT ${FIELDS} FROM auctioneers WHERE id=$1`, [t.id]);
      const row = result.rows[0];
      const state = targetState(row, t);
      beforeRows.push({ target: t, row: row ?? null, state });
    }
    const siteBefore = (await client.query(
      `SELECT domain, auctioneers, ufs, http_status, has_lots, platform, connector_id, title, checked_at, note
         FROM discovered_sites WHERE domain = ANY($1::text[]) ORDER BY domain`,
      [TARGETS.map(t => t.domain)],
    )).rows;
    const baseValid = counts.total === 1947 &&
      ((counts.com_domain === 1193 && beforeRows.every(r => r.state === 'ready')) ||
       (counts.com_domain === 1195 && beforeRows.every(r => r.state === 'already-applied')));
    const ready = beforeRows.filter(r => r.state === 'ready');
    const blocked = beforeRows.filter(r => r.state === 'blocked');
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', counts, target_states: beforeRows.map(r => ({ id: r.target.id, state: r.state })), planned_updates: ready.length, site_rows: siteBefore.length, baseValid }, null, 2));
    if (!baseValid || blocked.length) throw new Error('base ou compare-and-set diverge do snapshot aprovado; nenhuma escrita feita');
    if (!apply) return;
    if (ready.length === 0) {
      console.log(JSON.stringify({ updates: 0, idempotent: true }));
      return;
    }

    mkdirSync(DIR, { recursive: true });
    const backupPath = `${DIR}/backup-antes-apply.json`;
    const rollbackPath = `${DIR}/rollback-condicionado.sql`;
    const backup = { captured_at: new Date().toISOString(), counts, targets: beforeRows, discovered_sites: siteBefore };
    writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(rollbackPath,
      `-- Atomic: each guarded operation must affect exactly one row or the DO statement raises and rolls back.\nBEGIN;\n${generateConditionalRollbackSql(backup)}\nCOMMIT;\n`,
      { mode: 0o600 },
    );

    await client.query('BEGIN');
    transactionOpen = true;
    const applied: any[] = [];
    for (const entry of ready) {
      const t = entry.target;
      const updated = await client.query(
        `UPDATE auctioneers SET domain=$1, domain_origin=$2
          WHERE id=$3 AND registry=$4 AND external_id=$5 AND name=$6 AND matricula=$7 AND junta=$8
            AND uf=$9 AND uf_junta=$10 AND domain IS NOT DISTINCT FROM $11
            AND domain_origin IS NOT DISTINCT FROM $12 AND blocked=FALSE AND situacao ILIKE 'regular'
          RETURNING ${FIELDS}`,
        [t.domain, ORIGIN, t.id, t.registry, t.external_id, t.name, t.matricula, t.junta, t.uf, t.uf_junta,
          entry.row.domain, entry.row.domain_origin],
      );
      if (updated.rowCount !== 1) throw new Error(`compare-and-set falhou para id=${t.id}`);
      applied.push(updated.rows[0]);
    }
    for (const t of TARGETS) {
      await client.query(
        `INSERT INTO discovered_sites (domain, auctioneers, ufs) VALUES ($1,1,ARRAY[$2]::text[])
         ON CONFLICT (domain) DO UPDATE SET auctioneers=EXCLUDED.auctioneers, ufs=EXCLUDED.ufs`,
        [t.domain, t.uf],
      );
    }
    const afterCounts = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE domain IS NOT NULL AND domain <> '')::int AS com_domain FROM auctioneers`)).rows[0];
    if (afterCounts.total !== 1947 || afterCounts.com_domain !== 1195) throw new Error(`contagem pós-escrita inesperada: ${JSON.stringify(afterCounts)}`);
    const afterSites = (await client.query(
      `SELECT domain, auctioneers, ufs, http_status, has_lots, platform, connector_id, title, checked_at, note
         FROM discovered_sites WHERE domain = ANY($1::text[]) ORDER BY domain`,
      [TARGETS.map(t => t.domain)],
    )).rows;
    for (const t of TARGETS) {
      const before = siteBefore.find(r => r.domain === t.domain) ?? null;
      const after = afterSites.find(r => r.domain === t.domain) ?? null;
      checkSiteMetadata(before, after);
      if (after?.auctioneers !== 1 || !Array.isArray(after.ufs) || after.ufs.length !== 1 || after.ufs[0] !== t.uf) {
        throw new Error(`metadados de domínio inesperados: ${t.domain}`);
      }
    }
    await client.query('COMMIT');
    transactionOpen = false;

    const evidence = { applied_at: new Date().toISOString(), before_counts: counts, after_counts: afterCounts,
      applied, discovered_sites_before: siteBefore, discovered_sites_after: afterSites,
      backup: backupPath, conditional_rollback: rollbackPath, repeat_apply_updates: 0 };
    writeFileSync(`${DIR}/apply-evidencia.json`, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ applied: applied.map(r => ({ id: r.id, domain: r.domain, domain_origin: r.domain_origin })), afterCounts, backupPath, rollbackPath }, null, 2));
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
