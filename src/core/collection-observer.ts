import { createTenantObserver, type TenantObserver, type TenantObserverContext } from './tenant-attempts.js';

type Execute = (sql: string, params?: any[]) => Promise<any[]>;

export function observerForCollection(
  context: TenantObserverContext,
  enabled = process.env.TENANT_LEDGER_ENABLED === '1',
  execute?: Execute,
): TenantObserver | undefined {
  if (!enabled) return undefined;
  return execute ? createTenantObserver(context, execute) : createTenantObserver(context);
}

export function collectionJobContext(job: { id?: string } | undefined, origin: 'cron' | 'refresh') {
  const jobId = job?.id;
  const match = jobId?.match(/^repeat:.*:(\d{13})$/);
  const timestamp = match ? Number(match[1]) : NaN;
  const scheduledAt = Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? new Date(timestamp)
    : undefined;
  return { origin, ...(jobId ? { jobId } : {}), ...(scheduledAt ? { scheduledAt } : {}) };
}
