import { query } from '../query.js';
import type { TenantAttemptOutcome, TenantObserverContext } from '../../../domain/collection/tenant-attempts.js';

export type TenantAttemptExecute = (sql: string, params?: any[]) => Promise<any[]>;

export async function startTenantAttempt(context: TenantObserverContext, domain: string, execute: TenantAttemptExecute = query): Promise<number> {
  const rows = await execute(
    `INSERT INTO tenant_collection_attempts (run_id, source_id, domain, origin, job_id, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [context.runId, context.sourceId, domain, context.origin, context.jobId ?? null, context.scheduledAt ?? null],
  );
  const id = Number(rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Could not create tenant attempt');
  return id;
}

export async function finishTenantAttempt(id: number, outcome: TenantAttemptOutcome, execute: TenantAttemptExecute = query): Promise<void> {
  const { state, fetched, skipped, returned, latestStatus, responses, errorKind } = outcome;
  const updated = await execute(
    `UPDATE tenant_collection_attempts
             SET finished_at = now(), state = $2, fetched = $3, skipped = $4, returned = $5,
                 http_status = $6, http_responses = $7, error_kind = $8
             WHERE id = $1 AND state = 'running' RETURNING id`,
    [id, state, fetched, skipped, returned, latestStatus, responses, errorKind],
  );
  if (!updated.length) throw new Error('Tenant attempt is no longer running');
}
