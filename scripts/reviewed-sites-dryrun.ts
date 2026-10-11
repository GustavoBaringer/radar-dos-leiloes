/**
 * Dry-run do mapeamento revisado dos 20 domínios do snapshot de cobertura.
 *
 * - Emite /tmp/opencode/radar-cobertura-20/reviewed-mapping-dryrun.json.
 * - Com --apply, grava também reviewed-mapping-dryrun.sql no mesmo diretório.
 *   O SQL é só um artefato para revisão manual: NUNCA é executado aqui e
 *   NENHUMA escrita em banco acontece nesta rotina.
 * - Baseline (before.json) é lido apenas se existir; ausência não falha o run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connectors } from '../src/connectors/index.js';
import { REQUESTED_COVERAGE_DOMAINS20, TENANT_COVERAGE } from '../src/queue/tenant-coverage.js';
import { VIPLEILOES_DOMAINS } from '../src/connectors/vipleiloes.js';
import { isMonitorOnlyDomain } from '../src/connectors/htmlagenda.js';

const OUT_DIR = '/tmp/opencode/radar-cobertura-20';
const OUT_JSON = `${OUT_DIR}/reviewed-mapping-dryrun.json`;
const OUT_SQL = `${OUT_DIR}/reviewed-sites-dryrun.sql`;
const BASELINE = `${OUT_DIR}/before.json`;
const apply = process.argv.includes('--apply');

const connectorIds = new Set(connectors.map((c) => c.def.id));
const configured = new Map<string, string>(TENANT_COVERAGE.map((item) => [item.domain, item.sourceId]));
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const baselineDomains = new Map<string, any>((baseline?.domains ?? []).map((d: any) => [d.domain, d]));

function reviewedStatus(domain: string) {
  const sourceId = configured.get(domain);
  if (sourceId) {
    const monitorOnly = sourceId === 'htmlagenda' && isMonitorOnlyDomain(domain);
    return { status: monitorOnly ? 'monitor-only' : 'configured', sourceId,
      reason: monitorOnly ? 'monitoramento sem publicação: contrato de lotes não revisado' : null };
  }
  if (VIPLEILOES_DOMAINS.includes(domain as typeof VIPLEILOES_DOMAINS[number])) {
    // vipleiloes publica só Érico Sobral; Lance Certo é monitor-only até contrato real.
    return domain === 'ericosobral.com.br'
      ? { status: 'configured', sourceId: 'vipleiloes', reason: null }
      : { status: 'monitor-only', sourceId: 'vipleiloes', reason: 'cards TESTEVIP/demo; contrato real ainda pendente' };
  }
  const pending = REQUESTED_COVERAGE_DOMAINS20.find((item) => item.domain === domain);
  return { status: 'pending', sourceId: null, reason: pending && 'reason' in pending ? pending.reason : 'coverage pair pending' };
}

const domains = REQUESTED_COVERAGE_DOMAINS20.map((item) => {
  const reviewed = reviewedStatus(item.domain);
  const base = baselineDomains.get(item.domain) ?? null;
  return {
    domain: item.domain,
    ...reviewed,
    connectorRegistered: reviewed.sourceId ? connectorIds.has(reviewed.sourceId) : false,
    baseline: base && {
      lotsTotal: base.lotsTotal, lotsSearchEligible: base.lotsSearchEligible,
      httpStatus: base.site?.http_status ?? null, platform: base.site?.platform ?? null,
      connectorId: base.site?.connector_id ?? null,
    },
  };
});

const summary = {
  total: domains.length,
  configured: domains.filter((d) => d.status === 'configured').length,
  monitorOnly: domains.filter((d) => d.status === 'monitor-only').length,
  pending: domains.filter((d) => d.status === 'pending').length,
  baselinePresent: Boolean(baseline),
  applyRequested: apply,
  executedSql: false,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_JSON, `${JSON.stringify({ generatedAt: new Date().toISOString(), baselinePath: baseline ? BASELINE : null, summary, domains }, null, 2)}\n`);
console.log(JSON.stringify({ output: OUT_JSON, ...summary }, null, 2));

if (apply) {
  // Artefato de revisão: NÃO executar sem aprovação. Nenhum UPDATE roda aqui.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const statements = domains
    .filter((d) => d.status === 'configured' && d.sourceId)
    .map((d) => `-- ${d.domain}: ${d.sourceId}\nUPDATE discovered_sites SET connector_id=${quote(d.sourceId!)} WHERE domain=${quote(d.domain)} AND connector_id IS DISTINCT FROM ${quote(d.sourceId!)};`);
  writeFileSync(OUT_SQL, `-- Dry-run: artefato gerado por scripts/reviewed-sites-dryrun.ts. NÃO EXECUTADO.\n-- Revisar antes de qualquer aplicação manual.\n${statements.join('\n')}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ sqlOutput: OUT_SQL, statements: statements.length, executedSql: false }));
}
