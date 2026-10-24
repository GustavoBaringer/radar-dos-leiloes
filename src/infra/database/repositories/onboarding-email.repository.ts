import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

export const ONBOARDING_EMAIL_BATCH_SIZE = 10;
export const ONBOARDING_EMAIL_MAX_ATTEMPTS = 8;
const ONBOARDING_EMAIL_CLEANUP_BATCH_SIZE = 100;

export type OnboardingEmailLease = {
  outboxId: string;
  invitationId: string;
  attempts: number;
  leaseUntil: Date;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  encryptedToken: Uint8Array | null;
  name: string | null;
  email: string | null;
};

export type OnboardingEmailTerminalReason =
  | 'expired' | 'consumed';
export type OnboardingEmailRepairReason =
  | 'unsupported_purpose' | 'missing_recipient' | 'not_allowlisted' | 'invalid_ciphertext';

const ONBOARDING_EMAIL_REPAIR_PAUSE_UNTIL = new Date('9999-12-31T23:59:59.999Z');

export class OnboardingEmailRepository {
  constructor(private readonly prisma: PrismaService = PrismaService.getInstance()) {}

  claimPending(now: Date, leaseUntil: Date, includeActivation = false): Promise<OnboardingEmailLease[]> {
    return withDatabaseTransaction(this.prisma, async tx => {
      await queryWithClient(tx, `
        WITH stale AS (
          SELECT o.id, CASE WHEN i.expires_at <= $1 THEN 'expired' ELSE 'consumed' END AS reason
          FROM onboarding_email_outbox o
          JOIN onboarding_invitations i ON i.id = o.invitation_id
          WHERE o.sent_at IS NULL AND o.encrypted_token IS NOT NULL
            AND (o.lease_until IS NULL OR o.lease_until <= $1)
            AND (i.expires_at <= $1 OR i.consumed_at IS NOT NULL)
          ORDER BY o.available_at, o.created_at, o.id
          LIMIT $2
          FOR UPDATE OF o SKIP LOCKED
        ), cleared AS (
          UPDATE onboarding_email_outbox o
          SET encrypted_token = NULL, lease_until = NULL, last_error_sanitized = stale.reason
          FROM stale WHERE o.id = stale.id
          RETURNING o.id
        )
        SELECT id FROM cleared
      `, [now, ONBOARDING_EMAIL_CLEANUP_BATCH_SIZE]);

      return queryWithClient<OnboardingEmailLease>(tx, `
        WITH due AS (
          SELECT o.id, o.invitation_id
          FROM onboarding_email_outbox o
          JOIN onboarding_invitations i ON i.id = o.invitation_id
          WHERE o.sent_at IS NULL
            AND o.encrypted_token IS NOT NULL
            AND o.available_at <= $1
            AND (o.lease_until IS NULL OR o.lease_until <= $1)
            AND o.attempts < $4
            AND (i.purpose = 'checkout-invitation' OR ($5::boolean AND i.purpose = 'activation'
              AND EXISTS (
                SELECT 1 FROM onboarding_registrations r
                JOIN onboarding_initial_payments p ON p.activation_invitation_id=i.id AND p.cadastro_id=i.cadastro_id
                JOIN onboarding_checkout_attempts a ON a.id=p.checkout_attempt_id AND a.cadastro_id=p.cadastro_id
                WHERE r.cadastro_id=i.cadastro_id AND r.email_verified_at IS NOT NULL
                  AND p.state='paid_pending_activation'
                  AND p.payment_status IN ('CONFIRMED','RECEIVED') AND p.payment_value=69.90
                  AND p.payment_billing_type='CREDIT_CARD' AND p.subscription_status='ACTIVE'
                  AND p.subscription_value=69.90 AND p.cycle='MONTHLY'
                  AND p.payment_id<>'' AND p.subscription_id<>''
                  AND p.checkout_id=a.checkout_id AND a.state='created' AND a.checkout_id IS NOT NULL
              )))
            AND i.consumed_at IS NULL
            AND i.expires_at > $1
          ORDER BY o.available_at, o.created_at, o.id
          LIMIT $2
          FOR UPDATE OF o SKIP LOCKED
        )
        UPDATE onboarding_email_outbox o
        SET attempts = o.attempts + 1,
            lease_until = $3
        FROM due d
        JOIN onboarding_invitations i ON i.id = d.invitation_id
        JOIN onboarding_registrations r ON r.cadastro_id = i.cadastro_id
        JOIN cadastros c ON c.id = r.cadastro_id
        WHERE o.id = d.id
        RETURNING o.id AS "outboxId", o.invitation_id AS "invitationId",
          o.attempts, o.lease_until AS "leaseUntil", i.purpose,
          i.token_hash AS "tokenHash", i.expires_at AS "expiresAt",
          i.consumed_at AS "consumedAt", o.encrypted_token AS "encryptedToken",
          c.nome AS name, c.email
      `, [now, ONBOARDING_EMAIL_BATCH_SIZE, leaseUntil, ONBOARDING_EMAIL_MAX_ATTEMPTS, includeActivation]);
    });
  }

  async leaseIsCurrent(lease: OnboardingEmailLease, now: Date): Promise<boolean> {
    const rows = await queryWithClient<{ id: string }>(this.prisma, `
      SELECT o.id
      FROM onboarding_email_outbox o
      JOIN onboarding_invitations i ON i.id = o.invitation_id
      WHERE o.id = $1 AND o.attempts = $2 AND o.lease_until = $3 AND o.lease_until > $4
        AND o.sent_at IS NULL AND o.encrypted_token IS NOT NULL
        AND i.purpose = $5 AND i.consumed_at IS NULL AND i.expires_at > $4
        AND (i.purpose = 'checkout-invitation' OR (i.purpose = 'activation' AND EXISTS (
          SELECT 1 FROM onboarding_registrations r
          JOIN onboarding_initial_payments p ON p.cadastro_id=r.cadastro_id
          JOIN onboarding_checkout_attempts a ON a.id=p.checkout_attempt_id AND a.cadastro_id=p.cadastro_id
          WHERE r.cadastro_id=i.cadastro_id AND r.email_verified_at IS NOT NULL
            AND p.activation_invitation_id=i.id AND p.state='paid_pending_activation'
            AND p.payment_status IN ('CONFIRMED','RECEIVED') AND p.payment_value=69.90
            AND p.payment_billing_type='CREDIT_CARD' AND p.subscription_status='ACTIVE'
            AND p.subscription_value=69.90 AND p.cycle='MONTHLY'
            AND p.payment_id<>'' AND p.subscription_id<>''
            AND p.checkout_id=a.checkout_id AND a.state='created' AND a.checkout_id IS NOT NULL
        )))
    `, [lease.outboxId, lease.attempts, lease.leaseUntil, now, lease.purpose]);
    return rows.length === 1;
  }

  async markSent(lease: OnboardingEmailLease, now: Date): Promise<boolean> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const rows = await queryWithClient<{ id: string }>(tx, `
        UPDATE onboarding_email_outbox
        SET sent_at = $4, encrypted_token = NULL, lease_until = NULL, last_error_sanitized = NULL
        WHERE id = $1 AND attempts = $2 AND lease_until = $3
          AND lease_until > $4 AND sent_at IS NULL AND encrypted_token IS NOT NULL
        RETURNING id
      `, [lease.outboxId, lease.attempts, lease.leaseUntil, now]);
      return rows.length === 1;
    });
  }

  async scheduleRetry(lease: OnboardingEmailLease, now: Date, availableAt: Date): Promise<boolean> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const rows = await queryWithClient<{ id: string }>(tx, `
        UPDATE onboarding_email_outbox
        SET available_at = $5, lease_until = NULL, last_error_sanitized = 'smtp_error'
        WHERE id = $1 AND attempts = $2 AND lease_until = $3
          AND lease_until > $4 AND sent_at IS NULL AND encrypted_token IS NOT NULL
        RETURNING id
      `, [lease.outboxId, lease.attempts, lease.leaseUntil, now, availableAt]);
      return rows.length === 1;
    });
  }

  async clearExpiredOrConsumed(lease: OnboardingEmailLease, reason: OnboardingEmailTerminalReason, now: Date): Promise<boolean> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const rows = await queryWithClient<{ id: string }>(tx, `
        UPDATE onboarding_email_outbox
        SET encrypted_token = NULL, lease_until = NULL, last_error_sanitized = $4
        WHERE id = $1 AND attempts = $2 AND lease_until = $3
          AND lease_until > $5 AND sent_at IS NULL AND encrypted_token IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM onboarding_invitations i
            WHERE i.id = onboarding_email_outbox.invitation_id
              AND (($4 = 'expired' AND i.expires_at <= $5)
                OR ($4 = 'consumed' AND i.consumed_at IS NOT NULL))
          )
        RETURNING id
      `, [lease.outboxId, lease.attempts, lease.leaseUntil, reason, now]);
      return rows.length === 1;
    });
  }

  async pauseForRepair(lease: OnboardingEmailLease, reason: OnboardingEmailRepairReason, now: Date): Promise<boolean> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const rows = await queryWithClient<{ id: string }>(tx, `
        UPDATE onboarding_email_outbox
        SET attempts = $4, available_at = $5, lease_until = NULL, last_error_sanitized = $6
        WHERE id = $1 AND attempts = $2 AND lease_until = $3
          AND lease_until > $7 AND sent_at IS NULL AND encrypted_token IS NOT NULL
        RETURNING id
      `, [lease.outboxId, lease.attempts, lease.leaseUntil, ONBOARDING_EMAIL_MAX_ATTEMPTS,
        ONBOARDING_EMAIL_REPAIR_PAUSE_UNTIL, reason, now]);
      return rows.length === 1;
    });
  }
}
