/**
 * Plano revisável para corrigir vehicle_type e doc_type de vlance/leilo.
 * Dry-run por padrão; só --aplicar --plano=<json revisado> pode gravar.
 */
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/core/db.js';
import { scrubPlates, tipoForteDoTitulo } from '../src/core/normalize.js';
import { resolverCondicaoVlance } from '../src/core/campos.js';

type Row = {
  id: number; source_id: string; external_id: string | null; asset_type: string;
  vehicle_type: string | null; doc_type: string | null; title_raw: string;
  source_category: string | null; raw: Record<string, any> | null; lot_url: string | null;
};
type Change = {
  id: number; source: string; externalId: string | null; field: 'vehicle_type' | 'doc_type';
  before: string | null; after: string; evidence: { origin: string; rule: string };
  fingerprint: string;
};
const allowedSources = new Set(['vlance', 'leilo']);
const args = process.argv.slice(2);
const valueArg = (prefix: string) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
const flag = (s: string) => args.includes(s);
const fonte = valueArg('--fonte=');
if (fonte && !allowedSources.has(fonte)) throw new Error('--fonte deve ser vlance ou leilo');
const relatorio = resolve(valueArg('--relatorio=') ?? '/tmp/opencode/backfill-classificacao-filtros.json');
const planoPath = valueArg('--plano=') ? resolve(valueArg('--plano=')!) : null;
const aplicar = flag('--aplicar');
const reverter = valueArg('--reverter=') ? resolve(valueArg('--reverter=')!) : null;
const confirmar = flag('--confirmar-fonte');
const cachePath = valueArg('--cache-fonte=') ? resolve(valueArg('--cache-fonte=')!) : null;

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (u.username || u.password || isIP(h) || !h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return null;
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return null;
    return h;
  } catch { return null; }
}
export function fingerprint(r: Row): string {
  return hash({ source: r.source_id, externalId: r.external_id, asset: r.asset_type, title: r.title_raw,
    category: r.source_category, raw: r.raw ?? {}, vehicle: r.vehicle_type, doc: r.doc_type });
}
function evidenceDoTitulo(title: string, category: string | null): string | null {
  // Evidência qualificada exigida para correção de filtro: só os quatro tipos fortes aprovados.
  const forte = tipoForteDoTitulo(title, category);
  return forte && ['moto', 'maquina', 'nautico', 'caminhao'].includes(forte) ? forte : null;
}
export function isJudicial(r: Pick<Row, 'source_id' | 'doc_type'>): boolean {
  return r.source_id === 'vlance' && r.doc_type === 'judicial';
}
async function lerFonte(host: string): Promise<any[]> {
  const url = `https://${host}/core/api/get-lotes?tipo=1&qtd_por_pagina=5000`;
  const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(45000) });
  if (!response.ok || response.status >= 300) throw new Error(`vlance ${host}: HTTP ${response.status}`);
  const body = await response.json() as any;
  return Array.isArray(body?.items) ? body.items : [];
}
export function identity(it: any): { externalId: string; leilaoId: string } | null {
  const ext = it?.lote_id ?? it?.id; const lid = it?.leilao_id;
  return ext != null && lid != null ? { externalId: String(ext), leilaoId: String(lid) } : null;
}

export function groupChanges(changes: Change[]): Map<number, Change[]> {
  const grouped = new Map<number, Change[]>();
  for (const c of changes) { if (!grouped.has(c.id)) grouped.set(c.id, []); grouped.get(c.id)!.push(c); }
  return grouped;
}
export function scopeAllows(source: unknown, assetType: unknown): boolean {
  return typeof source === 'string' && allowedSources.has(source) && assetType === 'veiculo';
}
const FIELD_SET = new Set(['vehicle_type', 'doc_type']);
const DOC_SET = new Set(['sucata', 'conservado', 'sinistrado', 'recuperado_financiamento']);
export function validateChange(c: any): c is Change {
  return !!c && Number.isSafeInteger(c.id) && c.id > 0 && scopeAllows(c.source, 'veiculo') &&
    (c.externalId === null || typeof c.externalId === 'string') && FIELD_SET.has(c.field) &&
    (c.before === null || typeof c.before === 'string') && typeof c.after === 'string' &&
    (c.field === 'vehicle_type' ? ['carro', 'picape', 'suv'].includes(c.before) && ['moto', 'maquina', 'nautico', 'caminhao'].includes(c.after) : c.source === 'vlance' && c.before === 'judicial' && DOC_SET.has(c.after)) &&
    typeof c.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(c.fingerprint);
}
type SourceEvidence = { externalId: string; leilaoId: string; host: string; docType: string | null; origin: string | null; ambiguous: boolean; title: string };
function cacheKey(host: string, ext: string, lid: string) { return `${host}\0${ext}\0${lid}`; }

async function build(cache: Map<string, SourceEvidence>): Promise<{ report: any; rows: Row[] }> {
  const rs = await pool.query<Row>(
    `SELECT id, source_id, external_id, asset_type, vehicle_type, doc_type, title_raw,
            source_category, raw, lot_url
       FROM lots
      WHERE source_id = ANY($1) AND asset_type = 'veiculo'${fonte ? ' AND source_id = $2' : ''}
      ORDER BY source_id, id`,
    fonte ? [[...allowedSources], fonte] : [[...allowedSources]],
  );
  const rows = rs.rows;
  const src = new Map<string, Map<string, SourceEvidence>>();
  const ambiguous = new Set<number>();
  if (confirmar) {
    const hosts = new Set<string>();
    for (const r of rows) if (isJudicial(r)) {
      const h = validHost(r.raw?.tenant) ?? validHost(r.lot_url);
      if (h) hosts.add(h);
    }
    hosts.add('api.leiloesjudiciais.com.br');
    const needed = new Set(rows.filter(isJudicial).map((r) => {
      const host = validHost(r.raw?.tenant) ?? validHost(r.lot_url);
      return host && r.external_id != null && r.raw?.leilaoId != null ? cacheKey(host, String(r.external_id), String(r.raw.leilaoId)) : '';
    }).filter(Boolean));
    const hostsToFetch = new Set([...hosts].filter((host) => rows.some((r) => {
      if (!isJudicial(r)) return false;
      const h = validHost(r.raw?.tenant) ?? validHost(r.lot_url);
      return h === host && r.external_id != null && r.raw?.leilaoId != null && !cache.has(cacheKey(host, String(r.external_id), String(r.raw.leilaoId)));
    }) || host === 'api.leiloesjudiciais.com.br' && [...needed].some((k) => !cache.has(k))));
    for (const host of hostsToFetch) {
      try {
        const byIdentity = new Map<string, SourceEvidence[]>();
        for (const it of await lerFonte(host)) {
          const ident = identity(it); if (!ident) continue;
          const key = cacheKey(host, ident.externalId, ident.leilaoId);
          if (!needed.has(key)) continue;
          const classification = it.nm_classificacao ?? it.ds_classificacao ?? it.classificacao ?? null;
          let resolved = resolverCondicaoVlance({ assetType: 'veiculo', descricao: it.nm_descricao, classificacao: classification,
            classificacaoOrigem: classification ? 'classificacao' : null });
          let origin: string | null = resolved.origem ? `api.${resolved.origem}` : null;
          let ambiguity = resolved.ambiguo;
          if (!resolved.docType && !ambiguity) {
            resolved = resolverCondicaoVlance({ assetType: 'veiculo', titulo: it.nm_titulo_lote, categoria: it.nm_categoria });
            origin = resolved.origem ? `api.${resolved.origem}` : null;
            ambiguity = resolved.ambiguo;
          }
          const edital = String(it.nm_titulo_leilao ?? '');
          if (!resolved.docType && !ambiguity) {
            const f = edital.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
            const classeDedicada = /\bsucata\s+(?:inservivel|aproveitavel)\b|(?:^|\s)-\s*conservado\s*-?(?:\s|$)/.test(f) || /\b(?:sucata\s+)?(?:inservivel|aproveitavel)\b/.test(f) && /\b(?:lotes?|veiculos?)\s+(?:classificados?|enquadrados?)\s+(?:como\s+)?(?:sucata\s+)?(?:inservivel|aproveitavel)\b/.test(f);
            const misto = /\bconservad\w*\b/.test(f) && /\b(sucata|inservivel|irrecuperavel|aproveitavel)\b/.test(f);
            if (classeDedicada && !misto) {
              resolved = resolverCondicaoVlance({ assetType: 'veiculo', edital });
              origin = resolved.origem ? `api.${resolved.origem}` : null;
              ambiguity = resolved.ambiguo;
            }
          }
          const evidence: SourceEvidence = { externalId: ident.externalId, leilaoId: ident.leilaoId, host,
            docType: ambiguity ? null : resolved.docType, origin: ambiguity ? null : origin,
            ambiguous: ambiguity, title: scrubPlates(String(it.nm_titulo_lote ?? '')).text };
          if (!byIdentity.has(key)) byIdentity.set(key, []);
          byIdentity.get(key)!.push(evidence);
        }
        for (const [key, evidences] of byIdentity) {
          const unique = new Map(evidences.map((e) => [hash(e), e]));
          const e = [...unique.values()][0];
          cache.set(key, { ...e, ambiguous: e.ambiguous || unique.size !== 1 });
        }
      } catch { /* no source evidence: abstain */ }
    }
    // Cross-tenant observations are compared by resolved label + scrubbed title/category, never full description.
    const allEvidence = new Map<string, SourceEvidence[]>();
    for (const [key, e] of cache) if (needed.has(key)) { const k = `${e.externalId}\0${e.leilaoId}`; if (!allEvidence.has(k)) allEvidence.set(k, []); allEvidence.get(k)!.push(e); }
    for (const r of rows) if (isJudicial(r)) {
      const host = validHost(r.raw?.tenant) ?? validHost(r.lot_url);
      const key = host && r.external_id != null && r.raw?.leilaoId != null ? cacheKey(host, String(r.external_id), String(r.raw.leilaoId)) : '';
      const own = key ? cache.get(key) : null;
      const related = allEvidence.get(`${r.external_id}\0${String(r.raw?.leilaoId ?? '')}`) ?? [];
      const signatures = new Set(related.map((e) => hash({ docType: e.docType, title: e.title, ambiguous: e.ambiguous })));
      if (!own || !related.some((e) => e.host === host) || own.ambiguous || signatures.size > 1) ambiguous.add(r.id);
      else src.set(String(r.id), new Map([[key, own]]));
    }
  }
  const changes: Change[] = [];
  const skipped: Array<{ id: number; source: string; reason: string }> = [];
  for (const r of rows) {
    const fp = fingerprint(r);
    const strong = evidenceDoTitulo(r.title_raw, r.source_category);
    if (strong && ['carro', 'picape', 'suv'].includes(String(r.vehicle_type)) && strong !== r.vehicle_type) {
      changes.push({ id: r.id, source: r.source_id, externalId: r.external_id, field: 'vehicle_type', before: r.vehicle_type, after: strong,
        evidence: { origin: 'titulo+source_category', rule: 'tipoForteDoTitulo; tipo forte moto/maquina/nautico/caminhao; troca apenas de carro/picape/suv' }, fingerprint: fp });
    }
    if (isJudicial(r) && confirmar) {
      if (ambiguous.has(r.id)) { skipped.push({ id: r.id, source: r.source_id, reason: 'fonte ausente/conflitante ou identidade não confirmada' }); continue; }
      const host = validHost(r.raw?.tenant) ?? validHost(r.lot_url)!;
      const e = src.get(String(r.id))?.get(cacheKey(host, String(r.external_id), String(r.raw?.leilaoId ?? '')));
      if (e?.docType && e.docType !== 'judicial') changes.push({ id: r.id, source: r.source_id, externalId: r.external_id, field: 'doc_type', before: r.doc_type, after: e.docType,
        evidence: { origin: e.origin ?? 'api_confirmada', rule: 'resolverCondicaoVlance; external_id+leilaoId confirmado' }, fingerprint: fp });
      else skipped.push({ id: r.id, source: r.source_id, reason: 'sem evidência de condição não judicial inequívoca' });
    }
  }
  const cnt = (field: string, pick: (c: Change) => string) => Object.fromEntries([...new Set(changes.map(pick))].map((k) => [k, changes.filter((c) => pick(c) === k).length]));
  const review = changes.map((c) => { const r = rows.find((x) => x.id === c.id)!; return { ...c, title: scrubPlates(r.title_raw).text, sourceCategory: r.source_category }; });
  return { rows, report: { schema: 2, generatedAt: new Date().toISOString(), scope: { sources: fonte ? [fonte] : [...allowedSources], asset_type: 'veiculo' }, confirmation: confirmar,
    changes: review, skipped, counts: { candidates: rows.length, changes: changes.length, byField: cnt('field', (c) => c.field), bySource: cnt('source', (c) => c.source), byType: cnt('type', (c) => `${c.field}:${c.after}`), ambiguousOrConflict: ambiguous.size } } };
}

async function secureJson(path: string, value: unknown) {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true, mode: 0o700 }));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function main() {
  if (reverter && aplicar) throw new Error('Use --reverter ou --aplicar, não ambos');
  if (reverter) {
    const backup = JSON.parse(await readFile(reverter, 'utf8'));
    let restored = 0, skipped = 0;
    const client = await pool.connect();
    try { await client.query('BEGIN'); for (const x of backup.changes ?? []) {
      if (!validateChange({ ...x, fingerprint: '0'.repeat(64) })) throw new Error('Backup contém alteração não permitida');
      const res = await client.query(`UPDATE lots SET ${x.field}=$1 WHERE id=$2 AND source_id=$3 AND external_id IS NOT DISTINCT FROM $4 AND asset_type='veiculo' AND ${x.field} IS NOT DISTINCT FROM $5`, [x.before, x.id, x.source, x.externalId, x.after]);
      if (res.rowCount) restored++; else skipped++;
    } await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    console.log(JSON.stringify({ restored, skipped }, null, 2)); return;
  }
  if (aplicar && !planoPath) throw new Error('--aplicar exige --plano=arquivo previamente gerado e revisado');
  const cache = new Map<string, SourceEvidence>();
  if (cachePath) {
    try {
      const stored = JSON.parse(await readFile(cachePath, 'utf8')) as { schema?: number; entries?: Array<[string, SourceEvidence]> };
      if (stored.schema === 2 && Array.isArray(stored.entries)) for (const [key, evidence] of stored.entries) {
        if (typeof key === 'string' && evidence && validHost(evidence.host) && typeof evidence.externalId === 'string' && typeof evidence.leilaoId === 'string' &&
            (evidence.docType === null || DOC_SET.has(evidence.docType)) && typeof evidence.ambiguous === 'boolean') cache.set(key, evidence);
      }
    } catch { /* cache inexistente/ilegível: reconsulta */ }
  }
  const fresh = await build(cache);
  if (cachePath && confirmar) await secureJson(cachePath, { schema: 2, entries: [...cache.entries()] });
  if (!aplicar) { await secureJson(relatorio, fresh.report); console.log(`Dry-run: ${fresh.report.counts.changes} mudanças; relatório: ${relatorio}`); return; }
  const planned = JSON.parse(await readFile(planoPath!, 'utf8'));
  if (planned.schema !== 2 || JSON.stringify(planned.scope) !== JSON.stringify(fresh.report.scope) || planned.confirmation !== fresh.report.confirmation || hash(planned.changes) !== hash(fresh.report.changes) || !Array.isArray(planned.changes) || planned.changes.some((c: any) => !validateChange(c))) {
    throw new Error('Plano não corresponde à leitura atual (escopo, confirmação, evidências ou valores mudaram); gere/revise novo relatório');
  }
  const client = await pool.connect(); let changed = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    const backupChanges: any[] = [];
    for (const [id, changes] of groupChanges(planned.changes as Change[])) {
      const first = changes[0];
      if (changes.some((c) => c.source !== first.source || c.externalId !== first.externalId || c.fingerprint !== first.fingerprint) || new Set(changes.map((c) => c.field)).size !== changes.length) throw new Error(`Plano inválido para id ${id}`);
      const selected = await client.query<Row>(`SELECT id, source_id, external_id, asset_type, vehicle_type, doc_type, title_raw, source_category, raw
        FROM lots WHERE id=$1 FOR UPDATE`, [id]);
      const row = selected.rows[0];
      if (!row || row.source_id !== first.source || row.external_id !== first.externalId || row.asset_type !== 'veiculo' || fingerprint(row) !== first.fingerprint ||
          changes.some((c) => row[c.field] !== c.before)) { skipped += changes.length; continue; }
      const sets: string[] = []; const params: unknown[] = [];
      for (const c of changes) { if (!FIELD_SET.has(c.field)) throw new Error('Campo SQL não permitido'); params.push(c.after); sets.push(`${c.field}=$${params.length}`); }
      params.push(id, first.source, first.externalId);
      let where = `id=$${params.length - 2} AND source_id=$${params.length - 1} AND external_id IS NOT DISTINCT FROM $${params.length} AND asset_type='veiculo'`;
      for (const c of changes) { params.push(c.before); where += ` AND ${c.field} IS NOT DISTINCT FROM $${params.length}`; }
      const res = await client.query(`UPDATE lots SET ${sets.join(', ')} WHERE ${where}`, params);
      if (res.rowCount) {
        changed += changes.length;
        for (const c of changes) backupChanges.push({ id: c.id, source: c.source, externalId: c.externalId, field: c.field, before: c.before, after: c.after });
      } else skipped += changes.length;
    }
    const backupPath = `/tmp/opencode/backfill-classificacao-backup-${Date.now()}.json`;
    // Backup is durably written with mode 0600 before transaction commit.
    await secureJson(backupPath, { schema: 1, createdAt: new Date().toISOString(), changes: backupChanges });
    await client.query('COMMIT');
    console.log(JSON.stringify({ changed, skippedConcurrent: skipped, backup: backupPath }, null, 2));
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } finally { await pool.end(); }
}
