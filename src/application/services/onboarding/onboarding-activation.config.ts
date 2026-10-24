import { emailValido } from '../../../domain/identity/cadastro.js';
import { parseOnboardingTokenKey, sameOnboardingKeySecret } from '../../../infra/notifications/onboarding-token.js';

export const ONBOARDING_ACTIVATION_HTTP_SERVICE = Symbol('ONBOARDING_ACTIVATION_HTTP_SERVICE');

export type OnboardingActivationHttpConfig = {
  allowedEmails: ReadonlySet<string>;
  tokenKey: Buffer;
  issuer: string;
  clientId: string;
  redirectUri: string;
  publicOrigin: string;
  cookieSecure: boolean;
};

export type OnboardingActivationHttpService = {
  service: import('./onboarding-activation.service.js').OnboardingActivationService;
  config: OnboardingActivationHttpConfig;
};

function invalidConfig(): never {
  throw new Error('Onboarding activation HTTP requires a valid isolated staging configuration.');
}

export function loadOnboardingActivationHttpConfig(env: NodeJS.ProcessEnv): OnboardingActivationHttpConfig | null {
  if (env.ONBOARDING_ACTIVATION_HTTP_ENABLED !== 'true') return null;
  if (env.ONBOARDING_ACTIVATION_ENABLED !== 'true' || env.NODE_ENV !== 'staging' || env.ONBOARDING_MODE !== 'staging') {
    return invalidConfig();
  }

  const encodedKey = env.ONBOARDING_TOKEN_KEY;
  const allowedSource = env.ONBOARDING_ALLOWED_EMAILS;
  const baseSource = env.ONBOARDING_PUBLIC_BASE_URL;
  const issuerSource = env.OIDC_ISSUER;
  const clientId = env.OIDC_CLIENT_ID?.trim() ?? '';
  if (!encodedKey || !allowedSource || !baseSource || !issuerSource || !clientId
    || clientId.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(clientId)) return invalidConfig();

  let tokenKey: Buffer;
  let base: URL;
  let issuerUrl: URL;
  try {
    tokenKey = parseOnboardingTokenKey(encodedKey);
    base = new URL(baseSource);
    issuerUrl = new URL(issuerSource.replace(/\/$/, ''));
  } catch { return invalidConfig(); }

  const loopbacks = ['127.0.0.1', 'localhost', '[::1]'];
  const loopbackBase = base.protocol === 'http:' && loopbacks.includes(base.hostname)
    && env.ONBOARDING_ACTIVATION_ALLOW_LOOPBACK === 'true';
  const secureBase = base.protocol === 'https:';
  const loopbackIssuer = issuerUrl.protocol === 'http:' && loopbacks.includes(issuerUrl.hostname);
  if ((!secureBase && !loopbackBase) || base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || (!['https:', 'http:'].includes(issuerUrl.protocol) || (issuerUrl.protocol === 'http:' && !loopbackIssuer))
    || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) return invalidConfig();

  const emails = allowedSource.split(',').map(email => email.trim().toLowerCase());
  if (!emails.length || emails.some(email => !email || !emailValido(email))) return invalidConfig();
  if ([env.APP_SESSAO_SEGREDO, env.ASAAS_API_KEY, env.ASAAS_WEBHOOK_TOKEN, env.OIDC_CLIENT_SECRET]
    .some(secret => sameOnboardingKeySecret(tokenKey, encodedKey, secret))) return invalidConfig();

  return {
    allowedEmails: new Set(emails),
    tokenKey: Buffer.from(tokenKey),
    issuer: issuerUrl.toString().replace(/\/$/, ''),
    clientId,
    redirectUri: new URL('/auth/onboarding/callback', base.origin).toString(),
    publicOrigin: base.origin,
    cookieSecure: secureBase,
  };
}
