import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoverageReport, loadCoverageReport } from './relatorio-cobertura-dominios.js';

const reference = new Date('2026-10-10T00:00:00Z');

test('relatório distingue tentativa, sucesso de coleta e falha do run sem declarar persistência', () => {
  const report = buildCoverageReport(
    [{ domain: 'site-a.br' }, { domain: 'sem-ledger.br' }],
    [{
      source_id: 'connector-a', domain: 'site-a.br', last_attempt: '2026-10-09T00:00:00Z',
      last_state: 'completed', fetched: 5, skipped: 1, returned: 4, error_kind: null,
      http_status: 200, origin: 'cron', last_completed: '2026-10-09T00:00:00Z',
      has_run: true, run_ok: false, run_finished_at: '2026-10-09T00:01:00Z', run_error: 'upsert failed',
    }], reference);
  assert.equal(report.domains[0].returned, 4);
  assert.equal(report.domains[0].collection_run?.persisted, null);
  assert.match(report.domains[0].collection_run?.note ?? '', /persistência não presumida/);
  assert.deepEqual(report.unobserved_official_domains, ['sem-ledger.br']);
  assert.equal(report.domains[0].scope, 'unknown');
});

test('ledger ausente reporta inventário não observado, não zero monitorado', async () => {
  const report = await loadCoverageReport(async (sql): Promise<any[]> => {
    if (sql.includes('to_regclass')) return [{ exists: false }];
    if (sql.includes('FROM auctioneers')) return [{ domain: 'site-a.br' }];
    assert.fail('ledger query must not run when table is absent');
  }, reference);
  assert.equal(report.ledger_available, false);
  assert.equal(report.observed_source_domains_total, null);
  assert.match(report.diagnostic ?? '', /não significa zero tentativas/);
  assert.deepEqual(report.unobserved_official_domains, ['site-a.br']);
});
