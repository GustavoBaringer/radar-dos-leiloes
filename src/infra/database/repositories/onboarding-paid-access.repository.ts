import { calculatePaidAccessPeriods } from '../../../domain/billing/paid-access-period.js';
import { verifyInitialPayment } from '../../../domain/billing/verify-initial-payment.js';
import type { PaymentSnapshot, SubscriptionSnapshot } from '../../billing/asaas-sandbox.client.js';
import type { Prisma } from '../generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

type InitialOwner = {
  id: string; paymentId: string; subscriptionId: string; checkoutId: string;
  attemptId: string; attemptCheckoutId: string | null; priceCents: number;
  currency: string; billingType: string; cycle: string;
};

export class OnboardingPaidAccessRepository {
  private readonly emails: string[];

  constructor(
    allowedEmails: readonly string[] = [],
    private readonly prisma: PrismaService = PrismaService.getInstance(),
  ) {
    this.emails = [...new Set(allowedEmails.map(email => email.trim().toLowerCase()).filter(Boolean))];
  }

  recordCanonicalPayment(input: {
    eventId: string;
    payment: PaymentSnapshot;
    subscription: SubscriptionSnapshot;
  }): Promise<'committed' | 'replay' | 'pending' | 'review' | 'unmatched'> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const { eventId, payment, subscription } = input ?? {};
      if (!validId(eventId) || !payment || !subscription || !validId(payment.id)
        || !validId(subscription.id) || payment.subscription !== subscription.id) return 'review';
      if (!this.emails.length) return 'unmatched';

      const [owner] = await queryWithClient<InitialOwner>(tx, `
        SELECT ip.id, ip.payment_id AS "paymentId", ip.subscription_id AS "subscriptionId",
          ip.checkout_id AS "checkoutId", a.id AS "attemptId", a.checkout_id AS "attemptCheckoutId",
          a.price_cents AS "priceCents", a.currency, a.billing_type AS "billingType", a.cycle
        FROM onboarding_initial_payments ip
        JOIN onboarding_checkout_attempts a ON a.id=ip.checkout_attempt_id
        JOIN cadastros c ON c.id=ip.cadastro_id
        WHERE ip.subscription_id=$1 AND ip.state='paid_pending_activation'
          AND a.state='created' AND lower(c.email)=ANY($2::text[])
        FOR UPDATE OF ip
      `, [subscription.id, this.emails]);
      if (!owner) return 'unmatched';

      const [event] = await queryWithClient<{ kind: string; status: string; paymentId: string | null }>(tx, `
        SELECT kind, status, resource->>'id' AS "paymentId"
        FROM asaas_webhook_inbox WHERE event_id=$1 FOR UPDATE
      `, [eventId]);
      if (!event || event.kind !== 'payment' || event.paymentId !== payment.id
        || !['pending_reconciliation', 'reconciled'].includes(event.status)) return 'review';

      if (owner.checkoutId !== owner.attemptCheckoutId || !validId(owner.checkoutId)
        || owner.subscriptionId !== subscription.id) return 'review';

      const initialPayment = payment.id === owner.paymentId;
      if (initialPayment) {
        const verified = verifyInitialPayment({
          attempt: { checkoutId: owner.checkoutId, priceCents: owner.priceCents, currency: owner.currency,
            billingType: owner.billingType, cycle: owner.cycle },
          candidatePaymentId: owner.paymentId, payment, subscription,
        });
        if (verified.kind === 'pending') return 'pending';
        if (verified.kind !== 'eligible') return 'review';
      } else {
        if (owner.priceCents !== 6990 || owner.currency !== 'BRL' || owner.billingType !== 'CREDIT_CARD'
          || owner.cycle !== 'MONTHLY') return 'review';
        if (payment.value !== 69.9 || payment.billingType !== 'CREDIT_CARD'
          || subscription.status !== 'ACTIVE' || subscription.value !== 69.9 || subscription.cycle !== 'MONTHLY') return 'review';
        if ((payment.checkoutSession != null && payment.checkoutSession !== owner.checkoutId)
          || (subscription.checkoutSession != null && subscription.checkoutSession !== owner.checkoutId)) return 'review';
        if (payment.status === 'PENDING') {
          return 'pending';
        }
        if (payment.status !== 'CONFIRMED' && payment.status !== 'RECEIVED') return 'review';
      }

      const confirmedDate = payment.confirmedDate;
      if (typeof confirmedDate !== 'string') return 'review';
      let singlePeriod: ReturnType<typeof calculatePaidAccessPeriods>[number];
      try {
        [singlePeriod] = calculatePaidAccessPeriods([{ paymentId: payment.id, confirmedDate }]);
      } catch {
        return 'review';
      }
      const [today] = await queryWithClient<{ date: string }>(tx, `
        SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS date
      `);
      if (!today || confirmedDate > today.date) return 'review';

      const [initialOwnerOfPayment] = await queryWithClient<{ id: string }>(tx, `
        SELECT id FROM onboarding_initial_payments WHERE payment_id=$1
      `, [payment.id]);
      if (initialOwnerOfPayment && initialOwnerOfPayment.id !== owner.id) return 'review';

      const [existing] = await queryWithClient<{ paymentId: string; initialPaymentId: string; confirmedDate: string }>(tx, `
        SELECT payment_id AS "paymentId", initial_payment_id AS "initialPaymentId",
          to_char(confirmed_date, 'YYYY-MM-DD') AS "confirmedDate"
        FROM onboarding_paid_access_payments WHERE payment_id=$1
      `, [payment.id]);
      if (existing) {
        if (existing.initialPaymentId !== owner.id || existing.confirmedDate !== confirmedDate) return 'review';
        const [eventUse] = await queryWithClient<{ paymentId: string }>(tx, `
          SELECT payment_id AS "paymentId" FROM onboarding_paid_access_payments WHERE source_event_id=$1
        `, [eventId]);
        return eventUse && eventUse.paymentId !== payment.id ? 'review' : 'replay';
      }

      const [eventUse] = await queryWithClient<{ paymentId: string }>(tx, `
        SELECT payment_id AS "paymentId" FROM onboarding_paid_access_payments WHERE source_event_id=$1
      `, [eventId]);
      if (eventUse) return 'review';

      const [inserted] = await queryWithClient<{ paymentId: string }>(tx, `
        INSERT INTO onboarding_paid_access_payments
          (payment_id, initial_payment_id, source_event_id, confirmed_date, starts_at, ends_at)
        VALUES ($1,$2,$3,$4::date,$5,$6)
        ON CONFLICT DO NOTHING RETURNING payment_id AS "paymentId"
      `, [payment.id, owner.id, eventId, confirmedDate, singlePeriod.startsAt, singlePeriod.endsAt]);
      if (!inserted) {
        const [winner] = await queryWithClient<{ paymentId: string; initialPaymentId: string; confirmedDate: string }>(tx, `
          SELECT payment_id AS "paymentId", initial_payment_id AS "initialPaymentId",
            to_char(confirmed_date, 'YYYY-MM-DD') AS "confirmedDate"
          FROM onboarding_paid_access_payments WHERE payment_id=$1 OR source_event_id=$2
          ORDER BY (payment_id=$1) DESC LIMIT 1
        `, [payment.id, eventId]);
        return winner?.paymentId === payment.id && winner.initialPaymentId === owner.id
          && winner.confirmedDate === confirmedDate ? 'replay' : 'review';
      }

      // ponytail: recompute this subscriber's ledger for deterministic late events; optimize if histories become large.
      const rows = await queryWithClient<{ paymentId: string; confirmedDate: string }>(tx, `
        SELECT payment_id AS "paymentId", to_char(confirmed_date, 'YYYY-MM-DD') AS "confirmedDate"
        FROM onboarding_paid_access_payments WHERE initial_payment_id=$1
        ORDER BY confirmed_date, payment_id
      `, [owner.id]);
      const periods = calculatePaidAccessPeriods(rows);
      for (const period of periods) {
        await queryWithClient(tx, `UPDATE onboarding_paid_access_payments
          SET starts_at=$2, ends_at=$3 WHERE payment_id=$1 AND initial_payment_id=$4`,
        [period.paymentId, period.startsAt, period.endsAt, owner.id]);
      }
      return 'committed';
    });
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
