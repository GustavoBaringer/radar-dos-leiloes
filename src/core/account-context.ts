import { AccountContextService } from '../application/services/accounts/account-context.service.js';
import { AccountContextRepository, type AccountContextQuery } from '../infra/database/repositories/account-context.repository.js';

export { AccountContextError, buildMePayload } from '../domain/accounts/account-context.js';
export { VISIBLE_FAVORITE_PREDICATE } from '../infra/database/repositories/account-context.repository.js';
export type { AccountContextQuery } from '../infra/database/repositories/account-context.repository.js';

export function createAccountContext(queryFn: AccountContextQuery) {
  const service = new AccountContextService(new AccountContextRepository(queryFn));
  return {
    summarize: service.summarize.bind(service),
    decorateLots: service.decorateLots.bind(service),
  };
}
