import { pool, query } from '../src/core/db.js';

type Attempt = {
  source_id: string;
  domain: string;
  last_attempt: string | Date | null;
  last_state: string | null;
  fetched: number | null;
  skipped: number | null;
  returned: number | null;
  error_kind: string | null;
  http_status: number | null;
  origin: string | null;
  last_completed: string | Date | null;
  has_run: boolean;
  run_ok: boolean | null;
  run_finished_at: string | Date | null;
  run_error: string | null;
};
type Execute = (sql: string, params?: any[]) => Promise<any[]>;

function ageDays(value: string | Date | null, reference: Date): number | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((reference.getTime() - timestamp) / 86_400_000)) : null;
}

export function buildCoverageReport(
  officialDomains: readonly { domain: string }[],
  attempts: readonly Attempt[],
  reference = new Date(),
  limit = 200,
) {
  const observed = new Set(attempts.map((row) => row.domain.trim().toLowerCase()));
  const uniqueOfficial = [...new Set(officialDomains.map(({ domain }) => domain.trim().toLowerCase()).filter(Boolean))].sort();
  const unobserved = uniqueOfficial.filter((domain) => !observed.has(domain));
  const rows = attempts.slice(0, limit).map((row) => ({
    source_id: row.source_id,
    domain: row.domain,
    last_attempt: row.last_attempt,
    age_days: ageDays(row.last_attempt, reference),
    state: row.last_state,
    fetched: row.fetched,
    skipped: row.skipped,
    returned: row.returned,
    returned_semantics: 'itens retornados pelo coletor; não significa itens gravados',
    error_kind: row.error_kind,
    http_status: row.http_status,
    origin: row.origin,
    last_completed: row.last_completed,
    collection_run: !row.has_run ? null : {
      ok: row.run_ok,
      finished_at: row.run_finished_at,
      error: row.run_error,
      persisted: null,
      note: row.run_ok === true ? 'coleta concluída; persistência por domínio não comprovada' : 'collection_runs.ok != true; persistência não presumida',
    },
    scope: 'unknown',
  }));
  return {
    generated_at: reference.toISOString(),
    ledger_available: true,
    diagnostic: null as string | null,
    official_domains_total: uniqueOfficial.length,
    observed_source_domains_total: attempts.length,
    observed_source_domains_reported: rows.length,
    observed_source_domains_omitted: Math.max(0, attempts.length - rows.length),
    unobserved_official_domains_total: unobserved.length,
    unobserved_official_domains: unobserved.slice(0, limit),
    unobserved_official_domains_omitted: Math.max(0, unobserved.length - limit),
    domains: rows,
    limitations: [
      'Sem ledger não há evidência por domínio; conectores não instrumentados são não observados.',
      'Elegibilidade/escopo é unknown: o relatório não infere contratos ou exclusões genéricas.',
      'returned não significa gravado; completed não prova persistência.',
      'Domínios oficiais sem tentativa são listados sem atribuir source_id ou elegibilidade.',
    ],
  };
}

export async function loadCoverageReport(execute: Execute = query, reference = new Date(), limit = 200) {
  const [{ exists }] = await execute(`SELECT to_regclass('public.tenant_collection_attempts') IS NOT NULL AS exists`) as { exists: boolean }[];
  const officialDomains = await execute(
    `SELECT DISTINCT lower(trim(domain)) AS domain FROM auctioneers WHERE domain IS NOT NULL AND trim(domain) <> '' ORDER BY 1`,
  ) as { domain: string }[];
  if (!exists) {
    const report = buildCoverageReport(officialDomains, [], reference, limit);
    return {
      ...report,
      ledger_available: false,
      observed_source_domains_total: null,
      observed_source_domains_reported: null,
      observed_source_domains_omitted: null,
      diagnostic: 'tenant_collection_attempts ausente; ledger indisponível e domínios não observados (não significa zero tentativas).',
    };
  }
  const attempts = await execute(`
    WITH latest AS (
      SELECT DISTINCT ON (source_id, lower(trim(domain))) source_id, lower(trim(domain)) AS domain,
             id, run_id, started_at, finished_at, state, fetched, skipped, returned,
             error_kind, http_status, origin
        FROM tenant_collection_attempts
       ORDER BY source_id, lower(trim(domain)), started_at DESC, id DESC
    ), completed AS (
      SELECT source_id, lower(trim(domain)) AS domain, max(finished_at) AS last_completed
        FROM tenant_collection_attempts WHERE state = 'completed'
       GROUP BY source_id, lower(trim(domain))
    )
    SELECT l.source_id, l.domain, l.started_at AS last_attempt, l.state AS last_state,
           l.fetched, l.skipped, l.returned, l.error_kind, l.http_status, l.origin,
           c.last_completed, (l.run_id IS NOT NULL) AS has_run,
           r.ok AS run_ok, r.finished_at AS run_finished_at, r.error AS run_error
      FROM latest l LEFT JOIN completed c USING (source_id, domain)
      LEFT JOIN collection_runs r ON r.id = l.run_id
     ORDER BY l.source_id, l.domain
  `) as Attempt[];
  return buildCoverageReport(officialDomains, attempts, reference, limit);
}

if (process.argv[1]?.endsWith('/relatorio-cobertura-dominios.ts')) {
  try {
    console.log(JSON.stringify(await loadCoverageReport(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ledger_available: null,
      diagnostic: 'Falha ao consultar o esquema esperado; relatório incompleto, sem interpretar erro como ausência de tentativas.',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
