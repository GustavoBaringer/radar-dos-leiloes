import type { AntibotConfig, Mode, Policy, PolicyId } from './types.js';

export const POLICY_IDS: readonly PolicyId[] = [
  'search', 'detail', 'mapa', 'vitrine', 'cadastro', 'espera', 'login',
  'image', 'imageMiss', 'wsIp', 'wsAccount', 'write',
];

export const POLICIES: Readonly<Record<PolicyId, Policy>> = {
  search: { id: 'search', identity: 'account', max: 30, windowMs: 60_000 },
  detail: { id: 'detail', identity: 'account', max: 30, windowMs: 60_000 },
  mapa: { id: 'mapa', identity: 'account', max: 12, windowMs: 60_000 },
  vitrine: { id: 'vitrine', identity: 'ip', max: 30, windowMs: 60_000 },
  cadastro: { id: 'cadastro', identity: 'ip', max: 10, windowMs: 3_600_000 },
  espera: { id: 'espera', identity: 'ip', max: 10, windowMs: 3_600_000 },
  login: { id: 'login', identity: 'ip', max: 60, windowMs: 60_000 },
  image: { id: 'image', identity: 'ip', max: 120, windowMs: 60_000 },
  // Uma página tem 24 fotos; a galeria pode pedir mais 18 miniaturas e fotos grandes.
  // Mantém a cota por IP e os limites de dois jobs de imagem/quatro leituras ativos.
  imageMiss: { id: 'imageMiss', identity: 'ip', max: 100, windowMs: 60_000 },
  wsIp: { id: 'wsIp', identity: 'ip', max: 30, windowMs: 60_000 },
  wsAccount: { id: 'wsAccount', identity: 'account', max: 10, windowMs: 60_000 },
  write: { id: 'write', identity: 'account', max: 30, windowMs: 60_000 },
};

const strictInteger = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} deve ser inteiro decimal estrito`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} fora do intervalo ${min}..${max}`);
  return n;
};

const validRedisUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ANTIBOT_REDIS_URL/REDIS_URL inválida');
  }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
    throw new Error('ANTIBOT_REDIS_URL/REDIS_URL deve usar redis:// ou rediss://');
  }
  return value;
};

export function loadAntibotConfig(env: NodeJS.ProcessEnv): AntibotConfig {
  const production = env.NODE_ENV === 'production';
  const modeValue = env.ANTIBOT_MODE;
  if (production && modeValue === undefined) throw new Error('ANTIBOT_MODE obrigatório em produção');
  const mode: Mode = modeValue === undefined ? 'off' : modeValue === 'off' || modeValue === 'shadow' || modeValue === 'enforce'
    ? modeValue
    : (() => { throw new Error('ANTIBOT_MODE deve ser off, shadow ou enforce'); })();
  if (production && mode === 'off' && env.ANTIBOT_ALLOW_OFF !== '1') {
    throw new Error('ANTIBOT_MODE=off em produção exige ANTIBOT_ALLOW_OFF=1');
  }

  const environment = env.NODE_ENV ?? 'development';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment)) throw new Error('NODE_ENV inválido para namespace antibot');
  const redisUrl = validRedisUrl(env.ANTIBOT_REDIS_URL ?? env.REDIS_URL ?? 'redis://localhost:6380');
  const policies = Object.fromEntries(POLICY_IDS.map((id) => {
    const base = POLICIES[id];
    const name = id.toUpperCase();
    return [id, {
      ...base,
      max: strictInteger(env, `ANTIBOT_${name}_MAX`, base.max, 1, 10_000),
      windowMs: strictInteger(env, `ANTIBOT_${name}_WINDOW_MS`, base.windowMs, 1_000, 3_600_000),
    }];
  })) as Record<PolicyId, Policy>;

  return { mode, environment, redisUrl, policies };
}
