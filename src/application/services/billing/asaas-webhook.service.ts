import { createHash, timingSafeEqual } from 'node:crypto';
import { parseAsaasWebhook } from '../../../domain/billing/asaas-webhook.js';
import { AsaasWebhookInboxRepository } from '../../../infra/database/repositories/asaas-webhook-inbox.repository.js';
import { parseOnboardingTokenKey, sameOnboardingKeySecret } from '../../../infra/notifications/onboarding-token.js';

export const ASAAS_WEBHOOK_SERVICE = 'ASAAS_WEBHOOK_SERVICE';
export type AsaasWebhookConfig = { token: string };

export function loadAsaasWebhookConfig(env: NodeJS.ProcessEnv): AsaasWebhookConfig | null {
  if (env.ASAAS_WEBHOOK_ENABLED !== 'true') return null;
  const token = env.ASAAS_WEBHOOK_TOKEN;
  if (env.NODE_ENV !== 'staging' || env.ONBOARDING_MODE !== 'staging'
    || !token || token.length < 32 || token.length > 255 || /[^\x21-\x7e]/.test(token)) {
    throw new Error('Invalid Asaas webhook configuration.');
  }
  if (token === env.ASAAS_API_KEY || token === env.APP_SESSAO_SEGREDO) throw new Error('Invalid Asaas webhook configuration.');
  if (env.ONBOARDING_TOKEN_KEY) {
    try {
      const key = parseOnboardingTokenKey(env.ONBOARDING_TOKEN_KEY);
      if (sameOnboardingKeySecret(key, env.ONBOARDING_TOKEN_KEY, token)) throw new Error('Invalid Asaas webhook configuration.');
    } catch (error) {
      if ((error as Error).message === 'Invalid Asaas webhook configuration.') throw error;
    }
  }
  return { token };
}

export class AsaasWebhookService {
  constructor(private readonly config: AsaasWebhookConfig, private readonly inbox: AsaasWebhookInboxRepository) {}

  async receive(tokenHeader: unknown, body: unknown): Promise<void> {
    if (typeof tokenHeader !== 'string' || tokenHeader.length > 255 || !this.matches(tokenHeader)) {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
    const event = parseAsaasWebhook(body);
    await this.inbox.receive(event, event.kind === 'unsupported' ? 'ignored' : 'pending_reconciliation',
      event.kind === 'unsupported' ? 'unsupported_event_family' : null);
  }

  private matches(candidate: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(candidate), digest(this.config.token));
  }
}
