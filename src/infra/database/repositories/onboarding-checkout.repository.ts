import type { PrismaClient } from '../generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';

export type CheckoutAttempt = {
  id: string;
  firstDueDate: string;
};

export type CheckoutEmailLease = {
  id: string;
  invitationId: string;
  cadastroId: string;
  recipient: string | null;
  name: string | null;
  checkoutLink: string;
  attempts: number;
  leaseUntil: Date;
};

type ClaimedCheckoutAttempt = CheckoutAttempt & {
  priceCents: number;
  currency: string;
  billingType: string;
  cycle: string;
};

export class OnboardingCheckoutRepository {
  constructor(private readonly prisma: PrismaClient = PrismaService.getInstance()) {}

  async recoverStaleDispatches(allowedEmails: string[], staleBefore: Date): Promise<number> {
    if (!allowedEmails.length) return 0;
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts a
      SET state='unknown', safe_error_code='dispatch_outcome_unknown', updated_at=now()
      FROM cadastros c
      WHERE c.id=a.cadastro_id AND lower(c.email)=ANY($1::text[])
        AND a.state='dispatching' AND a.updated_at < $2
      RETURNING a.id
    `, [allowedEmails.map(email => email.trim().toLowerCase()), staleBefore]);
    return rows.length;
  }

  async claimNext(allowedEmails: string[]): Promise<ClaimedCheckoutAttempt | null> {
    if (!allowedEmails.length) return null;
    const rows = await queryWithClient<ClaimedCheckoutAttempt>(this.prisma, `
      UPDATE onboarding_checkout_attempts a
      SET state='dispatching', updated_at=now()
      WHERE a.id=(
        SELECT queued.id FROM onboarding_checkout_attempts queued
        JOIN cadastros c ON c.id=queued.cadastro_id
        WHERE queued.state='requested' AND lower(c.email)=ANY($1::text[])
        ORDER BY queued.created_at, queued.id
        FOR UPDATE OF queued SKIP LOCKED LIMIT 1
      )
      RETURNING a.id,
        to_char(a.next_due_date, 'YYYY-MM-DD') AS "firstDueDate",
        a.price_cents AS "priceCents", a.currency,
        a.billing_type AS "billingType", a.cycle
    `, [allowedEmails.map(email => email.trim().toLowerCase())]);
    return rows[0] ?? null;
  }

  async markCreated(id: string, checkout: { id: string; link: string }): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts
      SET state='created', checkout_id=$2, checkout_link=$3, safe_error_code=NULL, updated_at=now()
      WHERE id=$1 AND state IN ('dispatching', 'unknown')
        AND (state='dispatching' OR safe_error_code='dispatch_outcome_unknown')
      RETURNING id
    `, [id, checkout.id, checkout.link]);
    return rows.length === 1;
  }

  async claimCheckoutEmail(allowedEmails: string[], now: Date, leaseUntil: Date): Promise<CheckoutEmailLease | null> {
    if (!allowedEmails.length) return null;
    const rows = await queryWithClient<CheckoutEmailLease>(this.prisma, `
      WITH candidate AS (
        SELECT a.id FROM onboarding_checkout_attempts a
        JOIN cadastros c ON c.id=a.cadastro_id
        JOIN onboarding_invitations i ON i.id=a.invitation_id AND i.cadastro_id=a.cadastro_id
        JOIN onboarding_registrations r ON r.cadastro_id=a.cadastro_id
        WHERE a.state='created' AND a.checkout_link IS NOT NULL AND a.email_sent_at IS NULL
          AND coalesce(a.email_next_attempt_at, '-infinity'::timestamptz) <= $2
          AND (a.email_lease_until IS NULL OR a.email_lease_until <= $2)
          AND (a.email_error_code IS NULL OR (a.email_error_code='smtp_failure' AND a.email_attempts < 8))
          AND i.purpose='checkout-invitation' AND i.consumed_at IS NOT NULL AND r.email_verified_at IS NOT NULL
          AND lower(c.email)=ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM onboarding_initial_payments p WHERE p.checkout_attempt_id=a.id)
        ORDER BY a.created_at, a.id
        FOR UPDATE OF a SKIP LOCKED LIMIT 1
      )
      UPDATE onboarding_checkout_attempts a
      SET email_attempts=a.email_attempts+1, email_lease_until=$3, email_error_code=NULL
      FROM candidate x, cadastros c
      WHERE a.id=x.id AND c.id=a.cadastro_id
      RETURNING a.id, a.invitation_id AS "invitationId", a.cadastro_id AS "cadastroId",
        c.email AS recipient, c.nome AS name, a.checkout_link AS "checkoutLink",
        a.email_attempts AS attempts, a.email_lease_until AS "leaseUntil"
    `, [allowedEmails.map(email => email.trim().toLowerCase()), now, leaseUntil]);
    return rows[0] ?? null;
  }

  async checkoutEmailLeaseCurrent(lease: CheckoutEmailLease, now: Date): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      SELECT a.id FROM onboarding_checkout_attempts a
      JOIN onboarding_invitations i ON i.id=a.invitation_id AND i.cadastro_id=a.cadastro_id
      JOIN onboarding_registrations r ON r.cadastro_id=a.cadastro_id
      JOIN cadastros c ON c.id=a.cadastro_id
      WHERE a.id=$1 AND a.email_attempts=$2 AND a.email_lease_until=$3 AND a.email_lease_until > $4
        AND a.state='created' AND a.checkout_link=$5 AND a.email_sent_at IS NULL
        AND lower(c.email)=lower($6)
        AND i.purpose='checkout-invitation' AND i.consumed_at IS NOT NULL AND r.email_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM onboarding_initial_payments p WHERE p.checkout_attempt_id=a.id)
    `, [lease.id, lease.attempts, lease.leaseUntil, now, lease.checkoutLink, lease.recipient]);
    return rows.length === 1;
  }

  async markCheckoutEmailSent(lease: CheckoutEmailLease, sentAt: Date): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts SET email_sent_at=$4, email_lease_until=NULL, email_error_code=NULL
      WHERE id=$1 AND email_attempts=$2 AND email_lease_until=$3 AND email_lease_until > $4 AND email_sent_at IS NULL
        AND state='created' AND NOT EXISTS (SELECT 1 FROM onboarding_initial_payments p WHERE p.checkout_attempt_id=$1)
      RETURNING id
    `, [lease.id, lease.attempts, lease.leaseUntil, sentAt]);
    return rows.length === 1;
  }

  async retryCheckoutEmail(lease: CheckoutEmailLease, retryAt: Date, errorCode: string): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts SET email_next_attempt_at=$4, email_lease_until=NULL, email_error_code=$5
      WHERE id=$1 AND email_attempts=$2 AND email_lease_until=$3 AND email_lease_until > now() AND email_sent_at IS NULL AND state='created'
      RETURNING id
    `, [lease.id, lease.attempts, lease.leaseUntil, retryAt, errorCode]);
    return rows.length === 1;
  }

  async pauseCheckoutEmail(lease: CheckoutEmailLease, errorCode: string): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts SET email_lease_until=NULL, email_next_attempt_at=NULL, email_error_code=$3
      WHERE id=$1 AND email_attempts=$2 AND email_lease_until=$4 AND email_lease_until > now() AND email_sent_at IS NULL AND state='created'
      RETURNING id
    `, [lease.id, lease.attempts, errorCode, lease.leaseUntil]);
    return rows.length === 1;
  }

  async markRejected(id: string, safeErrorCode: string): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts
      SET state='rejected', safe_error_code=$2, updated_at=now()
      WHERE id=$1 AND state='dispatching'
      RETURNING id
    `, [id, safeErrorCode]);
    return rows.length === 1;
  }

  async markUnknown(id: string, safeErrorCode: string): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      UPDATE onboarding_checkout_attempts
      SET state='unknown', safe_error_code=$2, updated_at=now()
      WHERE id=$1 AND state='dispatching'
      RETURNING id
    `, [id, safeErrorCode]);
    return rows.length === 1;
  }
}
