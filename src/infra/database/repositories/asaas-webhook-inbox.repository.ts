import type { AsaasWebhookEvent } from '../../../domain/billing/asaas-webhook.js';
import { queryWithClient } from '../query.js';
import { PrismaService } from '../prisma.service.js';

export type AsaasWebhookInboxStatus = 'pending_reconciliation' | 'ignored';

export class AsaasWebhookInboxRepository {
  constructor(private readonly prisma: PrismaService = PrismaService.getInstance()) {}

  async receive(
    event: AsaasWebhookEvent,
    status: AsaasWebhookInboxStatus,
    reason: string | null,
  ): Promise<'inserted' | 'duplicate'> {
    const rows = await queryWithClient<{ eventId: string }>(this.prisma, `
      INSERT INTO asaas_webhook_inbox
        (event_id, event_type, provider_created_at, kind, resource, status, reason)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id AS "eventId"
    `, [event.eventId, event.eventType, event.providerCreatedAt ?? null, event.kind,
      event.resource === null ? null : JSON.stringify(event.resource), status, reason]);
    return rows.length ? 'inserted' : 'duplicate';
  }
}
