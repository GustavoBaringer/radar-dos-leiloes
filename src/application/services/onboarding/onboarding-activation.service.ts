import { randomBytes } from 'node:crypto';
import type {
  ActivationIntent,
  ActivationPrincipal,
  OnboardingActivationRepository,
  StartActivationMaterial,
} from '../../../infra/database/repositories/onboarding-activation.repository.js';
import type {
  ActivationOidcContext,
  completeActivationAuthorization,
  prepareActivationAuthorization,
} from '../../../infra/auth/oidc.adapter.js';
import { decryptOnboardingToken, encryptOnboardingToken, hashOnboardingToken } from '../../../infra/notifications/onboarding-token.js';

const INTENT_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_LENGTH = 4096;
const TEMPORARY_FAILURE = 'Activation temporarily unavailable';

type ActivationRepository = Pick<OnboardingActivationRepository,
  'startAtomic' | 'claimCallback' | 'bindAtomic' | 'failAtomic'>;
type ActivationAdapter = {
  prepareActivationAuthorization(context: ActivationOidcContext): ReturnType<typeof prepareActivationAuthorization>;
  completeActivationAuthorization(input: {
    context: ActivationOidcContext; code: string; returnedState: string;
  }): ReturnType<typeof completeActivationAuthorization>;
};
type ServiceConfig = { issuer: string; clientId: string; redirectUri: string; tokenKey: Uint8Array };

export class OnboardingActivationService {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly tokenKey: Uint8Array;

  constructor(
    private readonly repository: ActivationRepository,
    private readonly oidc: ActivationAdapter,
    config: ServiceConfig,
  ) {
    this.issuer = normalizeIssuer(config?.issuer);
    this.clientId = config?.clientId?.trim() ?? '';
    this.redirectUri = normalizeRedirect(config?.redirectUri);
    if (!this.clientId || this.clientId.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(this.clientId)) {
      throw new TypeError('Invalid activation OIDC configuration');
    }
    if (!(config.tokenKey instanceof Uint8Array) || config.tokenKey.byteLength !== 32) {
      throw new TypeError('Invalid activation token-key configuration');
    }
    this.tokenKey = Buffer.from(config.tokenKey);
  }

  async start(token: string): Promise<
    { status: 'started'; authorizationUrl: string; browserToken: string } | { status: 'invalid' }
  > {
    let invitationTokenHash: string;
    try { invitationTokenHash = hashOnboardingToken(token); } catch { return { status: 'invalid' }; }

    const state = opaqueToken();
    const nonce = opaqueToken();
    const verifier = opaqueToken();
    const browserToken = opaqueToken();
    const context: ActivationOidcContext = {
      state, nonce, verifier, issuer: this.issuer, clientId: this.clientId, redirectUri: this.redirectUri,
    };

    let authorizationUrl: string;
    try {
      ({ url: authorizationUrl } = await this.oidc.prepareActivationAuthorization(context));
    } catch {
      return { status: 'invalid' };
    }

    const input: StartActivationMaterial = {
      invitationTokenHash,
      stateHash: hashOnboardingToken(state),
      browserTokenHash: hashOnboardingToken(browserToken),
      nonce,
      encryptedVerifier: encryptOnboardingToken(verifier, this.tokenKey),
      issuer: this.issuer,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    };
    let result;
    try { result = await this.repository.startAtomic(input); } catch { throw new Error(TEMPORARY_FAILURE); }
    if (result.status !== 'started') return { status: 'invalid' };
    return { status: 'started', authorizationUrl, browserToken };
  }

  async complete(input: { state: string; browserToken: string; code: string }): Promise<
    { status: 'bound'; userId: string } | { status: 'invalid' | 'conflict' }
  > {
    let stateHash: string;
    let browserTokenHash: string;
    try {
      stateHash = hashOnboardingToken(input?.state);
      browserTokenHash = hashOnboardingToken(input?.browserToken);
    } catch { return { status: 'invalid' }; }
    if (typeof input.code !== 'string' || !input.code || input.code.length > MAX_CODE_LENGTH
      || /[\x00-\x1f\x7f-\x9f]/.test(input.code)) return { status: 'invalid' };

    let intent: ActivationIntent | null;
    try { intent = await this.repository.claimCallback(stateHash, browserTokenHash); }
    catch { throw new Error(TEMPORARY_FAILURE); }
    if (!intent) return { status: 'invalid' };

    if (!this.validIntent(intent) || intent.expiresAt.getTime() <= Date.now()) {
      await this.failSafely(intent.id, browserTokenHash);
      return { status: 'invalid' };
    }

    let principal: ActivationPrincipal;
    try {
      const verifier = decryptOnboardingToken(intent.encryptedVerifier, this.tokenKey);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new Error('invalid verifier');
      principal = await this.oidc.completeActivationAuthorization({
        context: {
          state: input.state,
          nonce: intent.nonce,
          verifier,
          issuer: intent.issuer,
          clientId: intent.clientId,
          redirectUri: intent.redirectUri,
        },
        code: input.code,
        returnedState: input.state,
      });
    } catch {
      await this.failSafely(intent.id, browserTokenHash);
      return { status: 'invalid' };
    }

    if (!validVerifiedPrincipal(principal)) {
      await this.failSafely(intent.id, browserTokenHash);
      return { status: 'invalid' };
    }

    let result;
    try { result = await this.repository.bindAtomic(intent.id, browserTokenHash, principal); }
    catch { await this.failSafely(intent.id, browserTokenHash); throw new Error(TEMPORARY_FAILURE); }
    if (result.status !== 'bound') {
      await this.failSafely(intent.id, browserTokenHash);
      return result;
    }
    return result;
  }

  private validIntent(intent: ActivationIntent): boolean {
    return !!intent && !!intent.id && !!intent.cadastroId
      && intent.issuer === this.issuer && intent.clientId === this.clientId && intent.redirectUri === this.redirectUri
      && typeof intent.nonce === 'string' && isOpaqueToken(intent.nonce)
      && intent.encryptedVerifier instanceof Uint8Array && intent.encryptedVerifier.byteLength === 72
      && intent.encryptedVerifier[0] === 1 && intent.expiresAt instanceof Date
      && Number.isFinite(intent.expiresAt.getTime());
  }

  private async failSafely(intentId: string, browserTokenHash: string): Promise<void> {
    try { await this.repository.failAtomic(intentId, browserTokenHash); }
    catch { throw new Error(TEMPORARY_FAILURE); }
  }
}

function opaqueToken(): string { return randomBytes(32).toString('base64url'); }
function isOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').length === 32
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function normalizeIssuer(value: string | undefined): string {
  if (typeof value !== 'string') throw new TypeError('Invalid activation OIDC issuer configuration');
  const issuer = value.replace(/\/$/, '');
  let url: URL;
  try { url = new URL(issuer); } catch { throw new TypeError('Invalid activation OIDC issuer configuration'); }
  if (url.username || url.password || url.search || url.hash || !allowedOrigin(url)) {
    throw new TypeError('Invalid activation OIDC issuer configuration');
  }
  return issuer;
}

function normalizeRedirect(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new TypeError('Invalid activation callback configuration');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid activation callback configuration'); }
  if (url.username || url.password || url.hash || !allowedOrigin(url)) {
    throw new TypeError('Invalid activation callback configuration');
  }
  return url.toString();
}

function allowedOrigin(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

function validVerifiedPrincipal(value: ActivationPrincipal): boolean {
  return !!value && value.emailVerified === true
    && typeof value.sub === 'string' && value.sub.trim().length > 0 && value.sub.length <= 512
    && !/[\x00-\x1f\x7f-\x9f]/.test(value.sub)
    && typeof value.email === 'string' && value.email.trim().length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())
    && (value.nome === null || (typeof value.nome === 'string' && value.nome.length <= 256
      && !/[\x00-\x1f\x7f-\x9f]/.test(value.nome)))
    && (value.papel === 'admin' || value.papel === 'comum');
}
