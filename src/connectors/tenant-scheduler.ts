import { query } from '../core/db.js';
import { rotateTenants } from './tenant-rotation.js';

/**
 * Seleção "due" de tenants: em vez de girar a roda cegamente, escolhe os
 * domínios que mais precisam de coleta, usando o ledger `tenant_collection_attempts`
 * (db/016). Ordem de prioridade:
 *   0. nunca tentados (ordem de entrada = ordem canônica da consulta)
 *   1. concluídos, mais antigos primeiro (finished_at/started_at ASC)
 *   2. não-concluídos (partial/failed/running), mais antigos primeiro; os que
 *      começaram há menos de 6h contam como ativos e ficam no fim da categoria
 *
 * Ledger desligado (`TENANT_LEDGER_ENABLED !== '1'`) ou query falhando:
 * volta para `rotateTenants` (rotação clássica por slot de cron).
 */
export interface TenantAttemptRow {
  domain: string;
  started_at?: Date | string | null;
  state?: string | null;
  finished_at?: Date | string | null;
}

type Execute = (sql: string, params?: any[]) => Promise<any[]>;

const ACTIVE_MS = 6 * 3600_000;

function normalizeDomain(value: string): string {
  let host = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

interface LatestAttempt { domain: string; state: string | null; started_at: Date | null; finished_at: Date | null }

/** Última tentativa por domínio (o DISTINCT ON do Postgres já garante isso; aqui protege entrada fake). */
function latestByDomain(rows: readonly TenantAttemptRow[]): Map<string, LatestAttempt> {
  const map = new Map<string, LatestAttempt>();
  for (const row of rows) {
    const domain = normalizeDomain(row.domain);
    if (!domain) continue;
    const next = { domain, state: row.state ?? null, started_at: toDate(row.started_at), finished_at: toDate(row.finished_at) };
    const prev = map.get(domain);
    if (!prev) { map.set(domain, next); continue; }
    const a = next.started_at?.getTime() ?? -Infinity;
    const b = prev.started_at?.getTime() ?? -Infinity;
    if (a >= b) map.set(domain, next);
  }
  return map;
}

/** Puro: normaliza/deduplica candidatos e ordena por "quem está mais na hora". */
export function selectDue(
  candidates: readonly string[],
  rows: readonly TenantAttemptRow[] = [],
  limit?: number,
  now = new Date(),
): string[] {
  const unique = [...new Set(candidates.map(normalizeDomain).filter(Boolean))];
  const count = limit === undefined ? Math.max(1, unique.length) : Math.floor(limit);
  if (!Number.isFinite(count) || count < 1) throw new RangeError('limit must be a positive finite number');
  if (!unique.length) return [];

  const latest = latestByDomain(rows);
  const nowMs = now.getTime();
  const ranked = unique.map((domain, index) => {
    const row = latest.get(domain);
    if (!row) return { domain, index, cat: 0, asof: index };
    if (row.state === 'completed') {
      const done = row.finished_at ?? row.started_at;
      return { domain, index, cat: 1, asof: done ? done.getTime() : 0 };
    }
    // partial/failed/running: começado há menos de 6h ainda está ativo → fim da fila;
    // mais velho que isso (inclusive 'running' órfão de worker caindo) volta a ser due.
    const startedMs = row.started_at ? row.started_at.getTime() : 0;
    const active = startedMs > nowMs - ACTIVE_MS;
    return { domain, index, cat: 2, asof: active ? Number.MAX_SAFE_INTEGER : startedMs };
  });
  ranked.sort((a, b) => a.cat - b.cat || a.asof - b.asof || a.index - b.index);
  return ranked.slice(0, count).map((r) => r.domain);
}

/** Última tentativa por domínio vinda do ledger (started_at DESC por domínio). */
export async function loadTenantAttempts(sourceId: string, execute: Execute = query): Promise<TenantAttemptRow[]> {
  const rows = await execute(
    `SELECT DISTINCT ON (lower(trim(domain))) lower(trim(domain)) AS domain, started_at, state, finished_at
       FROM tenant_collection_attempts
      WHERE source_id = $1
      ORDER BY lower(trim(domain)), started_at DESC`,
    [sourceId],
  );
  return (rows ?? []).map((r) => ({
    domain: normalizeDomain(String(r?.domain ?? '')),
    started_at: toDate(r?.started_at),
    state: r?.state ?? null,
    finished_at: toDate(r?.finished_at),
  })).filter((r) => r.domain);
}

/**
 * Single-tenant (Step4): mantém APENAS o tenant pedido na população elegível.
 * Compara normalizado (minúsculas, sem www nem ponto final) e devolve o texto
 * original da lista; [] quando o tenant não está na população — quem chama
 * recusa em vez de cair para "coletar a fonte inteira".
 */
export function filterTenantPopulation(domains: readonly string[], tenant: string): string[] {
  const alvo = normalizeDomain(String(tenant ?? ''));
  if (!alvo) return [];
  const hit = domains.find((d) => normalizeDomain(String(d ?? '')) === alvo);
  return hit === undefined ? [] : [String(hit).trim()];
}

export interface DueTenantsOptions {
  sourceId: string;
  candidates: readonly string[];
  limit: number;
  now?: Date;
  execute?: Execute;
  /** default: TENANT_LEDGER_ENABLED === '1' */
  track?: boolean;
}

export async function dueTenants(options: DueTenantsOptions): Promise<string[]> {
  const now = options.now ?? new Date();
  const track = options.track ?? process.env.TENANT_LEDGER_ENABLED === '1';
  if (!track) return rotateTenants(options.candidates, options.limit, now);
  try {
    const rows = await loadTenantAttempts(options.sourceId, options.execute ?? query);
    return selectDue(options.candidates, rows, options.limit, now);
  } catch (error) {
    if (process.env.TENANT_DUE_FALLBACK === '0') throw error;
    console.warn(`[tenant-scheduler] ledger indisponível (${options.sourceId}); rotação clássica:`,
      error instanceof Error ? error.message : error);
    return rotateTenants(options.candidates, options.limit, now);
  }
}
