import { createTenantObserver } from './tenant-observer.js';
import type { TenantObserver, TenantObserverContext } from '../../../domain/collection/tenant-attempts.js';

type Execute = (sql: string, params?: any[]) => Promise<any[]>;

export function observerForCollection(
  context: TenantObserverContext,
  enabled = process.env.TENANT_LEDGER_ENABLED === '1',
  execute?: Execute,
): TenantObserver | undefined {
  if (!enabled) return undefined;
  return execute ? createTenantObserver(context, execute) : createTenantObserver(context);
}

export { collectionJobContext } from '../../../infra/queue/collection-job-context.js';
