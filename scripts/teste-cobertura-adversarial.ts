import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDue, type TenantAttemptRow } from '../src/connectors/tenant-scheduler.js';
import { loadCoverageReport } from './relatorio-cobertura-dominios.js';

const start = new Date('2026-10-10T12:00:00Z');
type Picker = (candidates: string[], rows: TenantAttemptRow[], limit: number, now: Date) => string[];

function simulate(pick: Picker): string[] {
  const rows: TenantAttemptRow[] = [
    { domain: 'healthy.br', state: 'completed', started_at: new Date(start.getTime() - 3_600_000), finished_at: new Date(start.getTime() - 3_590_000) },
    { domain: 'failure.br', state: 'failed', started_at: new Date(start.getTime() - 48 * 3_600_000), finished_at: new Date(start.getTime() - 47 * 3_600_000) },
    { domain: 'never.br' },
  ];
  const selected: string[] = [];
  for (let cycle = 0; cycle < 8; cycle++) {
    const now = new Date(start.getTime() + cycle * 60_000);
    const domain = pick(['healthy.br', 'failure.br', 'never.br'], rows, 1, now)[0];
    selected.push(domain);
    const row = rows.find((item) => item.domain === domain)!;
    // Mutate the selected tenant's actual ledger state/timestamps like successive runs.
    row.started_at = now;
    row.finished_at = new Date(now.getTime() + 10_000);
    row.state = domain === 'failure.br' ? 'failed' : 'completed';
  }
  return selected;
}

function assertHealthyAndFailureProgress(selected: string[]) {
  assert.ok(selected.includes('healthy.br'), 'healthy tenant must complete at least once');
  assert.ok(selected.includes('failure.br'), 'failing tenant must recover a slot despite healthy completions');
}

test('multi-cycle selection refreshes selected tenant state; old failure is not starved (limit < pool)', () => {
  const selected = simulate(selectDue);
  assertHealthyAndFailureProgress(selected);
  assert.equal(selected.length, 8);
  assert.equal(selected[0], 'never.br', 'never-attempted tenant gets the initial slot');
});

test('same progress assertion rejects a completed-first regression', () => {
  const completedFirst: Picker = (candidates, rows, limit) => {
    const state = new Map(rows.map((row) => [row.domain, row.state]));
    return [...candidates].sort((a, b) => Number(state.get(a) !== 'completed') - Number(state.get(b) !== 'completed')).slice(0, limit);
  };
  const regressed = simulate(completedFirst);
  assert.deepEqual(regressed, Array(8).fill('healthy.br'));
  assert.throws(() => assertHealthyAndFailureProgress(regressed), /failing tenant must recover/);
});

test('recent partial keeps relative six-hour deferral behind more recent completion', () => {
  const now = new Date(start.getTime());
  const partial = { domain: 'partial.br', state: 'partial', started_at: new Date(now.getTime() - 2 * 3_600_000), finished_at: new Date(now.getTime() - 2 * 3_600_000) };
  const completed = { domain: 'completed.br', state: 'completed', started_at: new Date(now.getTime() - 3_600_000), finished_at: new Date(now.getTime() - 3_600_000) };
  assert.deepEqual(selectDue(['partial.br', 'completed.br'], [partial, completed], 1, now), ['completed.br']);
});

test('coverage SQL uses ledger origin and collection_runs fields available in db/016', async () => {
  const sql: string[] = [];
  const report = await loadCoverageReport(async (statement) => {
    sql.push(statement);
    if (statement.includes('to_regclass')) return [{ exists: true }];
    if (statement.includes('FROM auctioneers')) return [{ domain: 'site.br' }];
    if (statement.includes('FROM tenant_collection_attempts')) return [{
      source_id: 'connector', domain: 'site.br', last_attempt: start, last_state: 'completed',
      fetched: 1, skipped: 0, returned: 1, error_kind: null, http_status: 200, origin: 'refresh',
      last_completed: start, has_run: true, run_ok: false, run_finished_at: start, run_error: 'upsert failed',
    }];
    throw new Error(`unexpected SQL: ${statement}`);
  }, start);
  const attemptsSql = sql.find((statement) => statement.includes('FROM tenant_collection_attempts'))!;
  assert.match(attemptsSql, /l\.origin/);
  assert.match(attemptsSql, /r\.ok AS run_ok/);
  assert.doesNotMatch(attemptsSql, /r\.origin/); // collection_runs has no origin column.
  assert.match(attemptsSql, /GROUP BY source_id, lower\(trim\(domain\)\)/);
  assert.equal(report.domains[0].origin, 'refresh');
  assert.equal(report.domains[0].collection_run?.persisted, null);
  assert.equal(report.observed_source_domains_total, 1);
});
