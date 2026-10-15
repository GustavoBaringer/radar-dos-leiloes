import { normalizeTenantDomain, validateTenantObserverContext, TenantAttemptState,
  type TenantObserver, type TenantObserverContext } from '../../../domain/collection/tenant-attempts.js';
import { startTenantAttempt, finishTenantAttempt, type TenantAttemptExecute } from '../../../infra/database/repositories/tenant-attempts.repository.js';

/** The optional executor preserves existing callers' I/O seam; SQL lives only in infrastructure. */
export function createTenantObserver(context: TenantObserverContext, execute?: TenantAttemptExecute): TenantObserver {
  validateTenantObserverContext(context);
  return {
    async start(rawDomain) {
      const domain = normalizeTenantDomain(rawDomain);
      const id = await startTenantAttempt(context, domain, execute);
      const state = new TenantAttemptState();
      return {
        response(status) { state.response(status); },
        failure(kind) { state.failure(kind); },
        async finish(stats) {
          await finishTenantAttempt(id, state.prepareFinish(stats), execute);
          state.complete();
        },
      };
    },
  };
}
