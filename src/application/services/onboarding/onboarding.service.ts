import { randomBytes } from 'node:crypto';
import { emailValido } from '../../../domain/identity/cadastro.js';
import type { OnboardingRepository } from '../../../infra/database/repositories/onboarding.repository.js';
import { encryptOnboardingToken, hashOnboardingToken, parseOnboardingTokenKey, sameOnboardingKeySecret } from '../../../infra/notifications/onboarding-token.js';

export const ONBOARDING_SERVICE = 'ONBOARDING_SERVICE';
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface OnboardingRuntimeConfig {
  allowedEmails: ReadonlySet<string>;
  tokenKey: Buffer;
  publicBaseUrl: string;
}

export interface ValidatedOnboardingRegistration {
  nome: string;
  documento: string;
  tipoDocumento: 'CPF' | 'CNPJ';
  email: string;
  celular: string;
  versao: string;
  consentimento: string;
  ip: string | null;
  marketing: boolean;
  origem: string | null;
}

function invalidConfig(): never {
  throw new Error('Onboarding requires a valid, isolated staging configuration.');
}

export function loadOnboardingRuntimeConfig(env: NodeJS.ProcessEnv): OnboardingRuntimeConfig | null {
  if (env.ONBOARDING_ENABLED !== 'true') return null;
  if (env.NODE_ENV !== 'staging' || env.ONBOARDING_MODE !== 'staging') invalidConfig();

  const encodedKey = env.ONBOARDING_TOKEN_KEY;
  const allowedSource = env.ONBOARDING_ALLOWED_EMAILS;
  const baseSource = env.ONBOARDING_PUBLIC_BASE_URL;
  if (!encodedKey || !allowedSource || !baseSource) invalidConfig();

  let tokenKey: Buffer;
  let base: URL;
  try {
    tokenKey = parseOnboardingTokenKey(encodedKey);
    base = new URL(baseSource);
  } catch {
    return invalidConfig();
  }
  if (sameOnboardingKeySecret(tokenKey, encodedKey, env.APP_SESSAO_SEGREDO)
    || sameOnboardingKeySecret(tokenKey, encodedKey, env.ASAAS_WEBHOOK_TOKEN)) invalidConfig();

  const allowed = allowedSource.split(',').map(email => email.trim().toLowerCase());
  if (!allowed.length || allowed.some(email => !email || !emailValido(email))) invalidConfig();
  const isHttps = base.protocol === 'https:';
  const isLoopbackHttp = base.protocol === 'http:' && base.hostname === '127.0.0.1';
  if ((!isHttps && !isLoopbackHttp) || base.username || base.password || base.search || base.hash || base.pathname !== '/') invalidConfig();

  return { allowedEmails: new Set(allowed), tokenKey, publicBaseUrl: base.origin };
}

export class OnboardingService {
  constructor(
    private readonly repository: Pick<OnboardingRepository, 'createPendingInvitationAtomic' | 'consumeInvitationAtomic'>,
    private readonly config: OnboardingRuntimeConfig,
  ) {}

  async createInvitationForValidatedRegistration(registration: ValidatedOnboardingRegistration): Promise<void> {
    if (!this.config.allowedEmails.has(registration.email)) return;

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.repository.createPendingInvitationAtomic({
      cadastro: {
        nome: registration.nome,
        cpfCnpj: registration.documento,
        tipoDocumento: registration.tipoDocumento,
        email: registration.email,
        celular: registration.celular,
        consentimentoTermosEm: now,
        consentimentoVersao: registration.versao,
        consentimentoTexto: registration.consentimento,
        consentimentoIp: registration.ip,
        consentimentoMarketing: registration.marketing,
        origem: registration.origem,
      },
      tokenHash: hashOnboardingToken(token),
      encryptedToken: encryptOnboardingToken(token, this.config.tokenKey),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    });
    // Never return or log the bearer token; delivery reads only the encrypted outbox payload.
  }

  consumeInvitationToken(token: string): Promise<'consumed' | 'invalid' | 'expired' | 'already-consumed'> {
    let tokenHash: string;
    try { tokenHash = hashOnboardingToken(token); } catch { return Promise.resolve('invalid'); }
    return this.repository.consumeInvitationAtomic(tokenHash, new Date());
  }
}
