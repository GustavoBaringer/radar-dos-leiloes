import { randomUUID } from 'node:crypto';
import { verifyInitialPayment } from '../../../domain/billing/verify-initial-payment.js';
import type { PaymentSnapshot, SubscriptionSnapshot } from '../../billing/asaas-sandbox.client.js';
import type { Prisma } from '../generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

const LEASE_SECONDS = 120;
const SAFE_RELEASE_REASONS = new Set(['provider_unavailable', 'missing_subscription']);

export type ClaimedPaymentAttempt = {
  id: string;
  cadastroId: string;
  checkoutId: string;
  priceCents: number;
  currency: string;
  billingType: string;
  cycle: string;
  leaseToken: string;
};

type ActivationMaterial = { tokenHash: string; encryptedToken: Uint8Array; expiresAt: Date };
type ReconciliationResult = 'committed' | 'stale' | 'pending' | 'review';

export class OnboardingPaymentRepository {
  private readonly emails: string[];

  constructor(
    allowedEmails: readonly string[] = [],
    private readonly prisma: PrismaService = PrismaService.getInstance(),
  ) {
    this.emails = [...new Set(allowedEmails.map(email => email.trim().toLowerCase()).filter(Boolean))];
  }

  async readCandidate(eventId: string): Promise<{ eventId: string; paymentId: string } | null> {
    if (!eventId) return null;
    const [row] = await queryWithClient<{ eventId: string; paymentId: string }>(this.prisma, `
      SELECT event_id AS "eventId", resource->>'id' AS "paymentId"
      FROM asaas_webhook_inbox
      WHERE event_id=$1 AND status='pending_reconciliation' AND kind='payment'
        AND resource->>'id' IS NOT NULL AND resource->>'id' <> ''
    `, [eventId]);
    return row ?? null;
  }

  async findAttemptByCheckout(checkoutId: string): Promise<{ id: string } | null> {
    if (!checkoutId || !this.emails.length) return null;
    const [row] = await queryWithClient<{ id: string }>(this.prisma, `
      SELECT a.id
      FROM onboarding_checkout_attempts a
      JOIN cadastros c ON c.id=a.cadastro_id
      WHERE a.checkout_id=$1 AND a.state='created' AND lower(c.email)=ANY($2::text[])
      LIMIT 1
    `, [checkoutId, this.emails]);
    return row ?? null;
  }

  async claimReconciliation(attemptId: string): Promise<ClaimedPaymentAttempt | null> {
    if (!attemptId || !this.emails.length) return null;
    const leaseToken = randomUUID();
    const rows = await queryWithClient<ClaimedPaymentAttempt>(this.prisma, `
      UPDATE onboarding_checkout_attempts a
      SET reconciliation_lease_token=$2::uuid,
          reconciliation_lease_until=now()+($3::int * interval '1 second')
      FROM cadastros c
      WHERE a.id=$1 AND c.id=a.cadastro_id AND lower(c.email)=ANY($4::text[])
        AND a.state='created' AND a.checkout_id IS NOT NULL
        AND (a.reconciliation_lease_until IS NULL OR a.reconciliation_lease_until <= now())
      RETURNING a.id, a.cadastro_id AS "cadastroId", a.checkout_id AS "checkoutId",
        a.price_cents AS "priceCents", a.currency, a.billing_type AS "billingType",
        a.cycle, a.reconciliation_lease_token AS "leaseToken"
    `, [attemptId, leaseToken, LEASE_SECONDS, this.emails]);
    return rows[0] ?? null;
  }

  commitReconciliation(input: {
    attempt: ClaimedPaymentAttempt;
    eventId: string;
    candidatePaymentId: string;
    payment: PaymentSnapshot | null;
    subscription: SubscriptionSnapshot | null;
    activation: ActivationMaterial | null;
  }): Promise<ReconciliationResult> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const [attempt] = await queryWithClient<{
        id: string; cadastroId: string; checkoutId: string; priceCents: number; currency: string;
        billingType: string; cycle: string; leaseToken: string; email: string;
      }>(tx, `
        SELECT a.id, a.cadastro_id AS "cadastroId", a.checkout_id AS "checkoutId",
          a.price_cents AS "priceCents", a.currency, a.billing_type AS "billingType", a.cycle,
          a.reconciliation_lease_token AS "leaseToken", c.email
        FROM onboarding_checkout_attempts a JOIN cadastros c ON c.id=a.cadastro_id
        WHERE a.id=$1 AND a.state='created' AND a.reconciliation_lease_token=$2::uuid
          AND a.reconciliation_lease_until > now() AND lower(c.email)=ANY($3::text[])
        FOR UPDATE OF a
      `, [input.attempt.id, input.attempt.leaseToken, this.emails]);
      if (!attempt) return 'stale';

      const [event] = await queryWithClient<{
        eventId: string; status: string; kind: string; paymentId: string | null;
      }>(tx, `
        SELECT event_id AS "eventId", status, kind, resource->>'id' AS "paymentId"
        FROM asaas_webhook_inbox WHERE event_id=$1 FOR UPDATE
      `, [input.eventId]);
      if (!event || event.kind !== 'payment' || event.paymentId !== input.candidatePaymentId) {
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'review', 'candidate_mismatch');
        return 'review';
      }

      if (event.status === 'reconciled') {
        const [existing] = await queryWithClient<{ same: boolean }>(tx, `
          SELECT checkout_attempt_id=$2 AND payment_id=$3 AS same
          FROM onboarding_initial_payments WHERE source_event_id=$1
        `, [input.eventId, attempt.id, input.candidatePaymentId]);
        await this.releaseLease(tx, attempt.id, input.attempt.leaseToken);
        return existing?.same ? 'committed' : 'stale';
      }
      if (event.status === 'review') {
        await this.releaseLease(tx, attempt.id, input.attempt.leaseToken);
        return 'review';
      }
      if (event.status !== 'pending_reconciliation') return 'stale';

      const verified = verifyInitialPayment({
        attempt: {
          checkoutId: attempt.checkoutId, priceCents: attempt.priceCents, currency: attempt.currency,
          billingType: attempt.billingType, cycle: attempt.cycle,
        },
        candidatePaymentId: input.candidatePaymentId,
        payment: input.payment,
        subscription: input.subscription,
      });

      if (verified.kind === 'pending') {
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'pending_reconciliation', verified.reason);
        return 'pending';
      }

      const [existing] = await queryWithClient<{
        id: string; checkoutAttemptId: string; paymentId: string; subscriptionId: string;
        checkoutId: string; state: string;
      }>(tx, `
        SELECT id, checkout_attempt_id AS "checkoutAttemptId", payment_id AS "paymentId",
          subscription_id AS "subscriptionId", checkout_id AS "checkoutId", state
        FROM onboarding_initial_payments WHERE cadastro_id=$1 FOR UPDATE
      `, [attempt.cadastroId]);
      const correlated = canonicalBindingMatches(attempt, input.candidatePaymentId, input.payment, input.subscription);

      if (existing) {
        const same = existing.checkoutAttemptId === attempt.id && existing.paymentId === (input.payment?.id ?? null)
          && existing.subscriptionId === (input.subscription?.id ?? null)
          && existing.checkoutId === attempt.checkoutId;
        if (same && verified.kind === 'eligible' && existing.state === 'paid_pending_activation') {
          await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'reconciled', null);
          return 'committed';
        }
        if (correlated && existing.state !== 'review') {
          await queryWithClient(tx, `UPDATE onboarding_initial_payments SET state='review' WHERE id=$1`, [existing.id]);
        }
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'review',
          correlated ? 'conflicting_initial_payment' : verified.kind === 'review' ? verified.reason : 'provider_correlation_mismatch');
        return 'review';
      }

      if (verified.kind === 'review') {
        if (correlated) {
          const inserted = await this.insertPayment(tx, attempt, input.eventId, input.payment!, input.subscription!, null, 'review');
          if (!inserted) {
            await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'review', 'payment_identity_conflict');
            return 'review';
          }
        }
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'review', verified.reason);
        return 'review';
      }

      if (!input.activation || !validActivation(input.activation)) {
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'pending_reconciliation', 'activation_material_unavailable');
        return 'pending';
      }
      const [registration] = await queryWithClient<{ cadastroId: string }>(tx, `
        SELECT cadastro_id AS "cadastroId" FROM onboarding_registrations
        WHERE cadastro_id=$1 AND email_verified_at IS NOT NULL AND $2::timestamptz > now()
      `, [attempt.cadastroId, input.activation.expiresAt]);
      if (!registration) {
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'pending_reconciliation', 'activation_material_unavailable');
        return 'pending';
      }

      const [invitation] = await queryWithClient<{ id: string }>(tx, `
        INSERT INTO onboarding_invitations (cadastro_id, purpose, token_hash, expires_at)
        VALUES ($1, 'activation', $2, $3) RETURNING id
      `, [attempt.cadastroId, input.activation.tokenHash, input.activation.expiresAt]);
      const inserted = await this.insertPayment(tx, attempt, input.eventId, input.payment!, input.subscription!, invitation.id, 'paid_pending_activation');
      if (!inserted) {
        await queryWithClient(tx, `DELETE FROM onboarding_invitations WHERE id=$1`, [invitation.id]);
        await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'review', 'payment_identity_conflict');
        return 'review';
      }
      await queryWithClient(tx, `
        INSERT INTO onboarding_email_outbox (invitation_id, encrypted_token)
        VALUES ($1, $2)
      `, [invitation.id, Buffer.from(input.activation.encryptedToken)]);
      await this.finish(tx, attempt.id, input.attempt.leaseToken, input.eventId, 'reconciled', null);
      return 'committed';
    });
  }

  releaseReconciliation(attempt: ClaimedPaymentAttempt, eventId: string, reason: 'provider_unavailable' | 'missing_subscription'): Promise<void> {
    if (!SAFE_RELEASE_REASONS.has(reason)) return Promise.resolve();
    return withDatabaseTransaction(this.prisma, async tx => {
      const [row] = await queryWithClient<{ id: string }>(tx, `
        SELECT a.id FROM onboarding_checkout_attempts a JOIN cadastros c ON c.id=a.cadastro_id
        WHERE a.id=$1 AND a.reconciliation_lease_token=$2::uuid
          AND a.reconciliation_lease_until > now() AND lower(c.email)=ANY($3::text[])
        FOR UPDATE OF a
      `, [attempt.id, attempt.leaseToken, this.emails]);
      if (!row) return;
      await queryWithClient(tx, `UPDATE onboarding_checkout_attempts
        SET reconciliation_lease_token=NULL, reconciliation_lease_until=NULL
        WHERE id=$1 AND reconciliation_lease_token=$2::uuid`, [attempt.id, attempt.leaseToken]);
      await queryWithClient(tx, `UPDATE asaas_webhook_inbox
        SET reason=$2 WHERE event_id=$1 AND status='pending_reconciliation'`, [eventId, reason]);
    });
  }

  private async insertPayment(
    tx: Prisma.TransactionClient,
    attempt: { id: string; cadastroId: string; checkoutId: string },
    eventId: string,
    payment: PaymentSnapshot,
    subscription: SubscriptionSnapshot,
    activationInvitationId: string | null,
    state: 'paid_pending_activation' | 'review',
  ): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(tx, `
      INSERT INTO onboarding_initial_payments (
        cadastro_id, checkout_attempt_id, source_event_id, payment_id, subscription_id, checkout_id,
        payment_status, payment_value, payment_billing_type, subscription_status, subscription_value,
        cycle, state, observed_at, activation_invitation_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)
      ON CONFLICT DO NOTHING RETURNING id
    `, [attempt.cadastroId, attempt.id, eventId, payment.id, subscription.id, attempt.checkoutId,
      payment.status, payment.value, payment.billingType, subscription.status, subscription.value,
      subscription.cycle, state, activationInvitationId]);
    return rows.length === 1;
  }

  private async finish(
    tx: Prisma.TransactionClient,
    attemptId: string,
    leaseToken: string,
    eventId: string,
    status: 'pending_reconciliation' | 'reconciled' | 'review',
    reason: string | null,
  ): Promise<void> {
    await queryWithClient(tx, `UPDATE asaas_webhook_inbox SET status=$2, reason=$3 WHERE event_id=$1`, [eventId, status, reason]);
    await this.releaseLease(tx, attemptId, leaseToken);
  }

  private async releaseLease(tx: Prisma.TransactionClient, attemptId: string, leaseToken: string): Promise<void> {
    await queryWithClient(tx, `UPDATE onboarding_checkout_attempts
      SET reconciliation_lease_token=NULL, reconciliation_lease_until=NULL
      WHERE id=$1 AND reconciliation_lease_token=$2::uuid`, [attemptId, leaseToken]);
  }
}

function validActivation(value: ActivationMaterial): boolean {
  return /^[0-9a-f]{64}$/.test(value.tokenHash)
    && value.encryptedToken instanceof Uint8Array && value.encryptedToken.byteLength === 72
    && value.encryptedToken[0] === 1 && value.expiresAt instanceof Date
    && Number.isFinite(value.expiresAt.getTime());
}

function canonicalBindingMatches(
  attempt: { checkoutId: string },
  candidatePaymentId: string,
  payment: PaymentSnapshot | null,
  subscription: SubscriptionSnapshot | null,
): boolean {
  return payment !== null && subscription !== null
    && candidatePaymentId === payment.id
    && payment.subscription === subscription.id
    && payment.checkoutSession === attempt.checkoutId
    && subscription.checkoutSession === attempt.checkoutId;
}
