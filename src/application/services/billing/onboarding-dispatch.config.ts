import { loadAsaasWebhookConfig } from './asaas-webhook.service.js';
import { loadOnboardingActivationHttpConfig } from '../onboarding/onboarding-activation.config.js';
import { loadOnboardingRuntimeConfig, type OnboardingRuntimeConfig } from '../onboarding/onboarding.service.js';
import { sameOnboardingKeySecret } from '../../../infra/notifications/onboarding-token.js';

export type OnboardingDispatchConfig = {
  onboarding: OnboardingRuntimeConfig;
  apiKey: string | null;
  checkoutReturnUrl: string | null;
  from: string;
  activationEnabled: boolean;
  checkoutEmailEnabled: boolean;
  checkoutEnabled: boolean;
};

export function loadOnboardingDispatchConfig(env: NodeJS.ProcessEnv): OnboardingDispatchConfig | null {
  if (env.ONBOARDING_DISPATCH_ENABLED !== 'true') return null;
  try {
    const onboarding = loadOnboardingRuntimeConfig(env);
    if (!onboarding) throw new Error('invalid');
    if (new URL(onboarding.publicBaseUrl).protocol !== 'https:') throw new Error('invalid');
    const activationEmailEnabled = env.ONBOARDING_ACTIVATION_EMAIL_ENABLED === 'true';
    if (activationEmailEnabled && !loadOnboardingActivationHttpConfig(env)) throw new Error('invalid');
    const checkoutEnabled = env.ASAAS_CHECKOUT_ENABLED === 'true';
    const apiKey = checkoutEnabled ? env.ASAAS_API_KEY ?? null : null;
    const checkoutReturnUrl = checkoutEnabled ? env.ASAAS_CHECKOUT_RETURN_URL ?? null : null;
    if (checkoutEnabled) {
      if (!apiKey || !checkoutReturnUrl) throw new Error('invalid');
      if (!apiKey.trim() || /[\r\n]/.test(apiKey) || apiKey.length > 4096) throw new Error('invalid');
      if (apiKey === env.APP_SESSAO_SEGREDO || apiKey === env.ASAAS_WEBHOOK_TOKEN) throw new Error('invalid');
      if (sameOnboardingKeySecret(onboarding.tokenKey, env.ONBOARDING_TOKEN_KEY!, apiKey)) throw new Error('invalid');
      const returnUrl = new URL(checkoutReturnUrl);
      const origin = new URL(onboarding.publicBaseUrl);
      if (returnUrl.protocol !== 'https:' || returnUrl.origin !== origin.origin || returnUrl.username || returnUrl.password
        || returnUrl.hash || returnUrl.toString().length > 2048) throw new Error('invalid');
      if (!loadAsaasWebhookConfig(env)) throw new Error('invalid');
    }
    const checkoutEmailEnabled = env.ONBOARDING_CHECKOUT_EMAIL_ENABLED === 'true';
    const from = env.SMTP_FROM?.trim() ?? '';
    if ((!from || /[\r\n]/.test(from)) || !env.SMTP_HOST?.trim()) throw new Error('invalid');
    return {
      onboarding, apiKey, checkoutReturnUrl, from,
      activationEnabled: activationEmailEnabled, checkoutEmailEnabled, checkoutEnabled,
    };
  } catch {
    throw new Error('Invalid onboarding dispatch configuration.');
  }
}
