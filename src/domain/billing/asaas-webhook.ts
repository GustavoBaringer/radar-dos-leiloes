export type AsaasWebhookKind = 'payment' | 'subscription' | 'checkout' | 'unsupported';

export interface AsaasWebhookEvent {
  eventId: string;
  eventType: string;
  providerCreatedAt?: string;
  kind: AsaasWebhookKind;
  resource: Record<string, string | number> | null;
}

export class AsaasWebhookPayloadError extends Error {
  constructor() {
    super('Invalid Asaas webhook payload');
    this.name = 'AsaasWebhookPayloadError';
  }
}

const invalid = (): never => { throw new AsaasWebhookPayloadError(); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}

function optionalText(source: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = source[key];
  return value == null ? undefined : requiredText(value, max);
}

function resourceProjection(value: unknown, idKey: string, fields: string[]): Record<string, string | number> {
  if (!isRecord(value)) return invalid();
  const result: Record<string, string | number> = { id: requiredText(value[idKey], 200) };
  for (const key of fields) {
    const text = optionalText(value, key);
    if (text !== undefined) result[key] = text;
  }
  if (value.value != null) {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0) return invalid();
    result.value = value.value;
  }
  return result;
}

/** Projects an explicit allowlist; provider additions and nested checkout configuration are ignored. */
export function parseAsaasWebhook(value: unknown): AsaasWebhookEvent {
  if (!isRecord(value)) return invalid();
  const eventId = requiredText(value.id, 200);
  const eventType = requiredText(value.event, 100);
  const providerCreatedAt = optionalText(value, 'dateCreated', 100);
  let kind: AsaasWebhookKind = 'unsupported';
  let resource: Record<string, string | number> | null = null;
  if (eventType.startsWith('PAYMENT_')) {
    kind = 'payment';
    resource = resourceProjection(value.payment, 'id', ['status', 'billingType', 'externalReference', 'dueDate', 'confirmedDate', 'paymentDate', 'originalDueDate', 'nextDueDate', 'cycle', 'subscription', 'checkoutSession']);
  } else if (eventType.startsWith('SUBSCRIPTION_')) {
    kind = 'subscription';
    resource = resourceProjection(value.subscription, 'id', ['status', 'billingType', 'externalReference', 'dueDate', 'confirmedDate', 'paymentDate', 'originalDueDate', 'nextDueDate', 'cycle']);
  } else if (eventType.startsWith('CHECKOUT_')) {
    kind = 'checkout';
    resource = resourceProjection(value.checkout, 'id', ['status', 'billingType', 'externalReference', 'dueDate', 'confirmedDate', 'paymentDate', 'originalDueDate', 'nextDueDate', 'cycle']);
  }
  return { eventId, eventType, ...(providerCreatedAt === undefined ? {} : { providerCreatedAt }), kind, resource };
}
