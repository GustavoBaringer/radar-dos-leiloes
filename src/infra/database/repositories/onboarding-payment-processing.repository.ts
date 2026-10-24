import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

const ALLOWED_REASONS = new Set([
  'canonical_payment_mismatch',
  'canonical_subscription_mismatch',
  'paid_access_evidence_invalid',
]);

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && value.trim() === value;
}

export class OnboardingPaymentProcessingRepository {
  private readonly emails: string[];

  constructor(
    allowedEmails: readonly string[] = [],
    private readonly prisma: PrismaService = PrismaService.getInstance(),
  ) {
    this.emails = [...new Set(allowedEmails.map(email => email.trim().toLowerCase()).filter(Boolean))];
  }

  async readCandidate(eventId: string): Promise<{ eventId: string; paymentId: string } | null> {
    if (!this.emails.length || !validId(eventId)) return null;

    const rows = await queryWithClient<{ eventId: string; paymentId: string }>(this.prisma, `
      SELECT inbox.event_id AS "eventId", inbox.resource->>'id' AS "paymentId"
      FROM asaas_webhook_inbox inbox
      WHERE inbox.event_id = $1
        AND inbox.kind = 'payment'
        AND inbox.resource->>'id' IS NOT NULL
        AND inbox.resource->>'id' <> ''
        AND (
          inbox.status = 'pending_reconciliation'
          OR (
            inbox.status = 'reconciled'
            AND EXISTS (
              SELECT 1 FROM onboarding_initial_payments ip
              JOIN cadastros c ON c.id = ip.cadastro_id
              WHERE ip.source_event_id = inbox.event_id
                AND ip.state = 'paid_pending_activation'
                AND lower(c.email) = ANY($2::text[])
                AND NOT EXISTS (
                  SELECT 1 FROM onboarding_paid_access_payments p
                  WHERE p.payment_id = ip.payment_id
                    AND p.initial_payment_id = ip.id
                )
            )
          )
        )
    `, [eventId, this.emails]);

    const row = rows[0];
    if (!row || !validId(row.paymentId)) return null;
    return row;
  }

  async findOwnedSubscription(subscriptionId: string): Promise<{ initialPaymentId: string } | null> {
    if (!this.emails.length || !validId(subscriptionId)) return null;

    const rows = await queryWithClient<{ initialPaymentId: string }>(this.prisma, `
      SELECT ip.payment_id AS "initialPaymentId"
      FROM onboarding_initial_payments ip
      JOIN cadastros c ON c.id = ip.cadastro_id
      WHERE ip.subscription_id = $1
        AND ip.state = 'paid_pending_activation'
        AND lower(c.email) = ANY($2::text[])
    `, [subscriptionId, this.emails]);

    const row = rows[0];
    if (!row || !validId(row.initialPaymentId)) return null;
    return row;
  }

  async takeBatch(limit = 5): Promise<Array<{ eventId: string; paymentId: string }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new RangeError('Limit must be an integer between 1 and 20');
    }
    if (!this.emails.length) return [];

    return withDatabaseTransaction(this.prisma, async tx => {
      const rows = await queryWithClient<{ eventId: string; paymentId: string }>(tx, `
        WITH selected AS (
          SELECT inbox.event_id, inbox.resource->>'id' AS payment_id
          FROM asaas_webhook_inbox inbox
          WHERE inbox.kind = 'payment'
            AND inbox.resource->>'id' IS NOT NULL
            AND inbox.resource->>'id' <> ''
            AND (
              inbox.reconciliation_attempted_at IS NULL
              OR inbox.reconciliation_attempted_at <= now() - interval '30 seconds'
            )
            AND (
              inbox.status = 'pending_reconciliation'
              OR (
                inbox.status = 'reconciled'
                AND EXISTS (
                  SELECT 1 FROM onboarding_initial_payments ip
                  JOIN cadastros c ON c.id = ip.cadastro_id
                  WHERE ip.source_event_id = inbox.event_id
                    AND ip.state = 'paid_pending_activation'
                    AND lower(c.email) = ANY($1::text[])
                    AND NOT EXISTS (
                      SELECT 1 FROM onboarding_paid_access_payments p
                      WHERE p.payment_id = ip.payment_id
                        AND p.initial_payment_id = ip.id
                    )
                )
              )
            )
          ORDER BY
            inbox.reconciliation_attempted_at NULLS FIRST,
            inbox.received_at,
            inbox.event_id
          LIMIT $2
          FOR UPDATE OF inbox SKIP LOCKED
        )
        UPDATE asaas_webhook_inbox target
        SET reconciliation_attempted_at = now()
        FROM selected
        WHERE target.event_id = selected.event_id
        RETURNING selected.event_id AS "eventId", selected.payment_id AS "paymentId"
      `, [this.emails, limit]);

      return rows.filter(r => validId(r.eventId) && validId(r.paymentId));
    });
  }

  async finish(
    eventId: string,
    paymentId: string,
    outcome: 'reconciled' | 'review',
    reason: string | null = null,
  ): Promise<void> {
    if (!this.emails.length || !validId(eventId) || !validId(paymentId)) return;

    if (outcome !== 'reconciled' && outcome !== 'review') {
      throw new TypeError('Invalid outcome');
    }

    if (outcome === 'reconciled') {
      if (reason !== null) {
        throw new TypeError('Reason must be null for reconciled outcome');
      }
      await queryWithClient(this.prisma, `
        UPDATE asaas_webhook_inbox target
        SET status = 'reconciled',
            reason = NULL
        WHERE target.event_id = $1
          AND target.kind = 'payment'
          AND target.resource->>'id' = $2
          AND target.status IN ('pending_reconciliation', 'reconciled')
          AND EXISTS (
            SELECT 1 FROM onboarding_paid_access_payments p
            JOIN onboarding_initial_payments ip ON ip.id = p.initial_payment_id
            JOIN cadastros c ON c.id = ip.cadastro_id
            WHERE p.payment_id = $2
              AND lower(c.email) = ANY($3::text[])
          )
      `, [eventId, paymentId, this.emails]);
      return;
    }

    // outcome === 'review'
    if (reason !== null && !ALLOWED_REASONS.has(reason)) {
      throw new TypeError('Invalid reason for review outcome');
    }
    await queryWithClient(this.prisma, `
      UPDATE asaas_webhook_inbox
      SET status = 'review',
          reason = $3
      WHERE event_id = $1
        AND kind = 'payment'
        AND resource->>'id' = $2
        AND status IN ('pending_reconciliation', 'reconciled')
    `, [eventId, paymentId, reason]);
  }
}
