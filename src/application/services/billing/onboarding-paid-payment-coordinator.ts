import type { AsaasSandboxClient, PaymentSnapshot, SubscriptionSnapshot } from '../../../infra/billing/asaas-sandbox.client.js';
import type { OnboardingPaidAccessRepository } from '../../../infra/database/repositories/onboarding-paid-access.repository.js';
import type { OnboardingPaymentReconciler } from './onboarding-payment-reconciler.js';

type ProcessingRepository = {
  readCandidate(eventId: string): Promise<{ eventId: string; paymentId: string } | null>;
  /** initialPaymentId is the provider payment ID, not the database row UUID. */
  findOwnedSubscription(subscriptionId: string): Promise<{ initialPaymentId: string } | null>;
  finish(eventId: string, paymentId: string, outcome: 'reconciled' | 'review', reason: string | null): Promise<void>;
};

type CoordinatorResult = 'idle' | 'pending' | 'unmatched' | 'review' | 'committed' | 'replay';
type ReconciliationResult = Awaited<ReturnType<OnboardingPaymentReconciler['reconcileInbox']>>;

export class OnboardingPaidPaymentCoordinator {
  constructor(
    private readonly processing: ProcessingRepository,
    private readonly reconciler: Pick<OnboardingPaymentReconciler, 'reconcileInbox'>,
    private readonly paidAccess: Pick<OnboardingPaidAccessRepository, 'recordCanonicalPayment'>,
    private readonly client: Pick<AsaasSandboxClient, 'retrievePayment' | 'retrieveSubscription'>,
  ) {}

  async process(eventId: string): Promise<CoordinatorResult> {
    try {
      if (!validId(eventId)) return 'review';
      const candidate = await this.processing.readCandidate(eventId);
      if (!candidate) return 'idle';
      if (candidate.eventId !== eventId || !validId(candidate.paymentId)) return 'review';

      let payment = await this.retrievePayment(candidate.paymentId);
      if (!payment) return 'pending';
      if (payment.id !== candidate.paymentId) {
        await this.finishReview(candidate.eventId, candidate.paymentId, 'canonical_payment_mismatch');
        return 'review';
      }
      if (!validId(payment.subscription)) return 'pending';
      const originalSubscriptionId = payment.subscription;
      let subscription = await this.retrieveSubscription(originalSubscriptionId);
      if (!subscription) return 'pending';
      if (subscription.id !== originalSubscriptionId) {
        await this.finishReview(candidate.eventId, candidate.paymentId, 'canonical_subscription_mismatch');
        return 'review';
      }

      let owner = await this.processing.findOwnedSubscription(originalSubscriptionId);
      if (!owner) {
        if (!payment.checkoutSession) return 'unmatched';
        const result = await this.reconciler.reconcileInbox(candidate.eventId);
        if (result !== 'committed') return mapReconciliationResult(result);

        payment = await this.retrievePayment(candidate.paymentId);
        if (!payment) return 'pending';
        if (payment.id !== candidate.paymentId) {
          await this.finishReview(candidate.eventId, candidate.paymentId, 'canonical_payment_mismatch');
          return 'review';
        }
        if (payment.subscription !== originalSubscriptionId) {
          await this.finishReview(candidate.eventId, candidate.paymentId, 'canonical_subscription_mismatch');
          return 'review';
        }
        subscription = await this.retrieveSubscription(originalSubscriptionId);
        if (!subscription) return 'pending';
        if (subscription.id !== originalSubscriptionId) {
          await this.finishReview(candidate.eventId, candidate.paymentId, 'canonical_subscription_mismatch');
          return 'review';
        }
        owner = await this.processing.findOwnedSubscription(originalSubscriptionId);
        if (!owner) return 'pending';
      }

      const result = await this.paidAccess.recordCanonicalPayment({
        eventId: candidate.eventId, payment, subscription,
      });
      if (result === 'committed' || result === 'replay') {
        await this.processing.finish(candidate.eventId, candidate.paymentId, 'reconciled', null);
        return result;
      }
      if (result === 'review') {
        await this.finishReview(candidate.eventId, candidate.paymentId, 'paid_access_evidence_invalid');
        return 'review';
      }
      return result;
    } catch {
      throw new Error('Unable to process onboarding payment');
    }
  }

  private async retrievePayment(paymentId: string): Promise<PaymentSnapshot | null> {
    try { return await this.client.retrievePayment(paymentId); }
    catch { return null; }
  }

  private async retrieveSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    try { return await this.client.retrieveSubscription(subscriptionId); }
    catch { return null; }
  }

  private finishReview(eventId: string, paymentId: string, reason: string): Promise<void> {
    return this.processing.finish(eventId, paymentId, 'review', reason);
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function mapReconciliationResult(result: ReconciliationResult): CoordinatorResult {
  switch (result) {
    case 'idle': return 'idle';
    case 'unmatched': return 'unmatched';
    case 'pending': return 'pending';
    case 'review': return 'review';
    case 'committed': return 'committed';
    case 'busy':
    case 'stale': return 'pending';
  }
}
