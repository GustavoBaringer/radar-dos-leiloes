import { randomBytes } from 'node:crypto';
import type { PaymentSnapshot, SubscriptionSnapshot, AsaasSandboxClient } from '../../../infra/billing/asaas-sandbox.client.js';
import type { OnboardingPaymentRepository } from '../../../infra/database/repositories/onboarding-payment.repository.js';
import { verifyInitialPayment } from '../../../domain/billing/verify-initial-payment.js';
import type { InitialPaymentOutcome } from '../../../domain/billing/verify-initial-payment.js';
import { encryptOnboardingToken, hashOnboardingToken } from '../../../infra/notifications/onboarding-token.js';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

type ReconciliationRepository = Pick<OnboardingPaymentRepository,
  'readCandidate' | 'findAttemptByCheckout' | 'claimReconciliation' | 'commitReconciliation' | 'releaseReconciliation'>;

type ReconcilerResult = 'idle' | 'unmatched' | 'busy' | 'pending' | 'review' | 'committed' | 'stale';

export class OnboardingPaymentReconciler {
  private readonly tokenKey: Uint8Array;
  private readonly now: () => Date;

  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly client: Pick<AsaasSandboxClient, 'retrievePayment' | 'retrieveSubscription'>,
    config: { tokenKey: Uint8Array; now?: () => Date },
  ) {
    if (!(config.tokenKey instanceof Uint8Array) || config.tokenKey.byteLength !== 32) {
      throw new Error('Invalid onboarding token configuration');
    }
    this.tokenKey = Buffer.from(config.tokenKey);
    this.now = config.now ?? (() => new Date());
  }

  async reconcileInbox(eventId: string): Promise<ReconcilerResult> {
    try {
      return await this.reconcile(eventId);
    } catch {
      throw new Error('Unable to reconcile onboarding payment');
    }
  }

  private async reconcile(eventId: string): Promise<ReconcilerResult> {
    const candidate = await this.repository.readCandidate(eventId);
    if (!candidate) return 'idle';
    if (candidate.eventId !== eventId || !candidate.paymentId) return 'review';

    let initialPayment: PaymentSnapshot;
    try { initialPayment = await this.client.retrievePayment(candidate.paymentId); }
    catch { return 'pending'; }
    if (initialPayment.id !== candidate.paymentId) return 'review';
    if (!initialPayment.checkoutSession) return 'unmatched';

    const found = await this.repository.findAttemptByCheckout(initialPayment.checkoutSession);
    if (!found) return 'unmatched';
    const attempt = await this.repository.claimReconciliation(found.id);
    if (!attempt) return 'busy';

    let payment: PaymentSnapshot;
    try { payment = await this.client.retrievePayment(candidate.paymentId); }
    catch {
      await this.repository.releaseReconciliation(attempt, eventId, 'provider_unavailable');
      return 'pending';
    }
    if (payment.id !== candidate.paymentId) {
      await this.repository.releaseReconciliation(attempt, eventId, 'provider_unavailable');
      return 'review';
    }
    if (!payment.subscription) {
      await this.repository.releaseReconciliation(attempt, eventId, 'missing_subscription');
      return 'pending';
    }
    let subscription: SubscriptionSnapshot;
    try { subscription = await this.client.retrieveSubscription(payment.subscription); }
    catch {
      await this.repository.releaseReconciliation(attempt, eventId, 'provider_unavailable');
      return 'pending';
    }

    const decision: InitialPaymentOutcome = verifyInitialPayment({
      attempt,
      candidatePaymentId: candidate.paymentId,
      payment,
      subscription,
    });
    const activation = decision.kind === 'eligible'
      ? this.createActivation()
      : null;
    const committed = await this.repository.commitReconciliation({
      attempt,
      eventId,
      candidatePaymentId: candidate.paymentId,
      payment,
      subscription,
      activation,
    });
    if (committed !== 'committed') return committed;
    return decision.kind === 'eligible' ? 'committed' : decision.kind;
  }

  private createActivation(): { tokenHash: string; encryptedToken: Uint8Array; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid service clock');
    return {
      tokenHash: hashOnboardingToken(token),
      encryptedToken: encryptOnboardingToken(token, this.tokenKey),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    };
  }
}
