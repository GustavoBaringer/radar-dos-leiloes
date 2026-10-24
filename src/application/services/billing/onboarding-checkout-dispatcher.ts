import {
  AsaasCheckoutOutcomeUnknownError,
  AsaasRequestRejectedError,
  AsaasSandboxClient,
} from '../../../infra/billing/asaas-sandbox.client.js';
import {
  OnboardingCheckoutRepository,
  type CheckoutAttempt,
} from '../../../infra/database/repositories/onboarding-checkout.repository.js';

const STALE_DISPATCH_MS = 2 * 60 * 1000;
const SAFE_ERRORS = {
  rejected: 'provider_request_rejected',
  unknown: 'provider_outcome_unknown',
  invalidPlan: 'invalid_plan_snapshot',
  dispatchFailure: 'dispatch_failure',
} as const;

export type CheckoutClient = Pick<AsaasSandboxClient, 'createCheckout'>;
export type CheckoutDispatchResult = 'idle' | 'created' | 'rejected' | 'unknown';

export class OnboardingCheckoutDispatcher {
  constructor(
    private readonly repository: OnboardingCheckoutRepository,
    private readonly client: CheckoutClient,
    private readonly allowedEmails: string[],
    private readonly returnUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async dispatchOnce(): Promise<CheckoutDispatchResult> {
    const staleBefore = new Date(this.now().getTime() - STALE_DISPATCH_MS);
    await this.repository.recoverStaleDispatches(this.allowedEmails, staleBefore);
    const attempt = await this.repository.claimNext(this.allowedEmails);
    if (!attempt) return 'idle';

    if (!validSnapshot(attempt)) {
      await this.repository.markUnknown(attempt.id, SAFE_ERRORS.invalidPlan);
      return 'unknown';
    }

    let checkout;
    try {
      checkout = await this.client.createCheckout({
        attemptId: attempt.id,
        returnUrl: this.returnUrl,
        firstDueDate: attempt.firstDueDate,
      });
    } catch (error) {
      if (error instanceof AsaasRequestRejectedError) {
        await this.repository.markRejected(attempt.id, SAFE_ERRORS.rejected);
        return 'rejected';
      }
      const safeError = error instanceof AsaasCheckoutOutcomeUnknownError
        ? SAFE_ERRORS.unknown : SAFE_ERRORS.dispatchFailure;
      await this.repository.markUnknown(attempt.id, safeError);
      return 'unknown';
    }

    try {
      const stored = await this.repository.markCreated(attempt.id, checkout);
      return stored ? 'created' : 'unknown';
    } catch {
      // The provider may have created the checkout. Never put this attempt back in the queue.
      try { await this.repository.markUnknown(attempt.id, SAFE_ERRORS.unknown); } catch { /* remains dispatching for stale recovery */ }
      return 'unknown';
    }
  }
}

function validSnapshot(attempt: CheckoutAttempt & {
  priceCents?: number; currency?: string; billingType?: string; cycle?: string;
}): boolean {
  const dueDate = new Date(`${attempt.firstDueDate}T00:00:00Z`);
  return attempt.priceCents === 6990 && attempt.currency === 'BRL'
    && attempt.billingType === 'CREDIT_CARD' && attempt.cycle === 'MONTHLY'
    && /^\d{4}-\d{2}-\d{2}$/.test(attempt.firstDueDate)
    && Number.isFinite(dueDate.getTime()) && dueDate.toISOString().slice(0, 10) === attempt.firstDueDate;
}
