import { randomUUID } from 'node:crypto';

export const CHALLENGE_ACTIONS = ['login', 'cadastro', 'espera'] as const;
export type ChallengeAction = typeof CHALLENGE_ACTIONS[number];
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 3_000;
const MAX_PENDING = 2;
const DEFAULT_HOSTNAMES = ['radardeleiloes.app.br', 'www.radardeleiloes.app.br'] as const;

export interface ChallengeConfig {
  mode: 'off' | 'enforce';
  production: boolean;
  siteKey: string | null;
  secretKey: string | null;
  hostnames: readonly string[];
}

export type ChallengeVerification = { ok: true } | { ok: false; kind: 'invalid' | 'unavailable' };
export type ChallengeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function loadChallengeConfig(env: NodeJS.ProcessEnv): ChallengeConfig {
  const production = env.NODE_ENV === 'production';
  const modeValue = env.ANTIBOT_CHALLENGE_MODE;
  if (production && modeValue === undefined) throw new Error('ANTIBOT_CHALLENGE_MODE obrigatório em produção');
  const mode = modeValue === undefined ? 'off' : modeValue;
  if (mode !== 'off' && mode !== 'enforce') throw new Error('ANTIBOT_CHALLENGE_MODE deve ser off ou enforce');
  if (production && mode === 'off' && env.ANTIBOT_CHALLENGE_ALLOW_OFF !== '1') {
    throw new Error('ANTIBOT_CHALLENGE_MODE=off em produção exige ANTIBOT_CHALLENGE_ALLOW_OFF=1');
  }

  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() || null;
  const hostnames = env.TURNSTILE_HOSTNAMES === undefined
    ? [...DEFAULT_HOSTNAMES]
    : env.TURNSTILE_HOSTNAMES.split(',').map((host) => host.trim().toLowerCase());
  if (hostnames.length === 0 || hostnames.some((host) => !host || host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host))) {
    throw new Error('TURNSTILE_HOSTNAMES inválido');
  }
  if (production && hostnames.some((host) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1')) {
    throw new Error('TURNSTILE_HOSTNAMES de produção inválido');
  }
  if (mode === 'enforce' && (!siteKey || !secretKey)) throw new Error('Turnstile site key e secret key obrigatórios em enforce');
  if (production && (isDummyKey(siteKey) || isDummyKey(secretKey))) {
    throw new Error('Chaves de teste Turnstile não permitidas em produção');
  }
  return { mode, production, siteKey, secretKey, hostnames: Object.freeze([...new Set(hostnames)]) };
}

function isDummyKey(key: string | null): boolean {
  return !!key && (/^(?:1x|2x|3x)0{8,}/i.test(key) || /DUMMY/i.test(key));
}

export function createChallengeService(options: { config: ChallengeConfig; fetch?: ChallengeFetch }) {
  const { config } = options;
  // Capture the runtime fetch once, allowing QA bootstrap to install its own
  // fetch before importing/constructing the service.
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  let pending = 0;

  async function verify(action: ChallengeAction, token: unknown): Promise<ChallengeVerification> {
    if (config.mode === 'off') return { ok: true };
    if (!CHALLENGE_ACTIONS.includes(action) || typeof token !== 'string' || token.length === 0 || token.length > 2048 || !token.trim()) {
      return { ok: false, kind: 'invalid' };
    }
    if (!config.siteKey || !config.secretKey) return { ok: false, kind: 'unavailable' };
    if (pending >= MAX_PENDING) return { ok: false, kind: 'unavailable' };

    pending++;
    try {
      const response = await fetchFn(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: config.secretKey, response: token, idempotency_key: randomUUID() }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, kind: 'unavailable' };
      let result: unknown;
      try { result = await response.json(); } catch { return { ok: false, kind: 'unavailable' }; }
      if (!result || typeof result !== 'object') return { ok: false, kind: 'unavailable' };
      const data = result as Record<string, unknown>;
      if (typeof data.success !== 'boolean') return { ok: false, kind: 'unavailable' };
      if (data.success !== true) return { ok: false, kind: 'invalid' };
      if (typeof data.hostname !== 'string' || !config.hostnames.includes(data.hostname.toLowerCase()) || data.action !== action) {
        return { ok: false, kind: 'invalid' };
      }
      return { ok: true };
    } catch {
      return { ok: false, kind: 'unavailable' };
    } finally {
      pending--;
    }
  }

  return {
    verify,
    clientConfig: () => ({
      enabled: config.mode === 'enforce',
      siteKey: config.mode === 'enforce' ? config.siteKey : null,
      actions: [...CHALLENGE_ACTIONS] as ChallengeAction[],
    }),
  };
}

const ACTION_BY_ROUTE: Readonly<Record<string, ChallengeAction>> = {
  'POST /api/login': 'login',
  'POST /api/cadastro': 'cadastro',
  'POST /api/espera': 'espera',
};

export function createChallengeHook(service: Pick<ReturnType<typeof createChallengeService>, 'verify'>) {
  return async (request: any, reply: any): Promise<void> => {
    if (request.method !== 'POST') return;
    const action = ACTION_BY_ROUTE[`${request.method} ${request.routeOptions?.url ?? request.routerPath ?? ''}`];
    if (!action) return;
    const body = request.body;
    const token = body && typeof body === 'object' && !Array.isArray(body) ? body.turnstileToken : undefined;
    const result = await service.verify(action, token);
    if (result.ok) return;
    reply.code(result.kind === 'invalid' ? 403 : 503).header('Cache-Control', 'no-store');
    if (result.kind === 'invalid') reply.send({ error: 'challenge_failed' });
    else reply.header('Retry-After', '3').send({ error: 'challenge_unavailable', retryAfterSeconds: 3 });
  };
}
