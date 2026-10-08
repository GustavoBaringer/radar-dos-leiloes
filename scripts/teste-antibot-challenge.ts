import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  createChallengeHook,
  createChallengeService,
  loadChallengeConfig,
  type ChallengeFetch,
} from '../src/core/antibot/challenge.js';

const validEnv = (extra: NodeJS.ProcessEnv = {}) => ({
  NODE_ENV: 'test', ANTIBOT_CHALLENGE_MODE: 'enforce',
  TURNSTILE_SITE_KEY: 'public-site-key', TURNSTILE_SECRET_KEY: 'server-secret',
  ...extra,
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

test('challenge config defaults off locally and requires explicit production mode/off authorization', () => {
  assert.equal(loadChallengeConfig({ NODE_ENV: 'development' }).mode, 'off');
  assert.throws(() => loadChallengeConfig({ NODE_ENV: 'production' }), /obrigatório/);
  assert.throws(() => loadChallengeConfig({ NODE_ENV: 'production', ANTIBOT_CHALLENGE_MODE: 'off' }), /ANTIBOT_CHALLENGE_ALLOW_OFF/);
  assert.equal(loadChallengeConfig({ NODE_ENV: 'production', ANTIBOT_CHALLENGE_MODE: 'off', ANTIBOT_CHALLENGE_ALLOW_OFF: '1' }).mode, 'off');
  assert.throws(() => loadChallengeConfig({ NODE_ENV: 'production', ANTIBOT_CHALLENGE_MODE: 'enforce' }), /obrigatórios/);
  for (const key of [
    '1x00000000000000000000AA', '1x00000000000000000000BB',
    '2x00000000000000000000AB', '2x00000000000000000000BB',
    '3x00000000000000000000FF',
  ]) {
    assert.throws(() => loadChallengeConfig({ ...validEnv({ NODE_ENV: 'production' }), TURNSTILE_SITE_KEY: key }), /Chaves de teste/);
  }
  for (const key of [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
  ]) {
    assert.throws(() => loadChallengeConfig({ ...validEnv({ NODE_ENV: 'production' }), TURNSTILE_SECRET_KEY: key }), /Chaves de teste/);
  }
  assert.throws(() => loadChallengeConfig({ ...validEnv({ NODE_ENV: 'production' }), TURNSTILE_HOSTNAMES: 'localhost' }), /de produção inválido/);
  assert.equal(loadChallengeConfig({ ...validEnv(), TURNSTILE_HOSTNAMES: 'localhost' }).hostnames[0], 'localhost');
  assert.deepEqual(loadChallengeConfig(validEnv()).hostnames, ['radardeleiloes.app.br', 'www.radardeleiloes.app.br']);
});

test('off service passes without calling provider and client config exposes no secret', async () => {
  let calls = 0;
  const service = createChallengeService({ config: loadChallengeConfig({ NODE_ENV: 'test' }), fetch: (async () => { calls++; throw Error(); }) as ChallengeFetch });
  assert.deepEqual(await service.verify('cadastro', undefined), { ok: true });
  assert.equal(calls, 0);
  assert.deepEqual(service.clientConfig(), { enabled: false, siteKey: null, actions: ['login', 'cadastro', 'espera'] });
  assert.doesNotMatch(JSON.stringify(service.clientConfig()), /secret|server-secret/);
});

test('Siteverify sends exact HTTPS payload with UUID idempotency and validates success/action/hostname', async () => {
  let call: { url: string; init?: RequestInit } | undefined;
  const service = createChallengeService({
    config: loadChallengeConfig(validEnv()),
    fetch: (async (url: any, init?: RequestInit) => { call = { url: String(url), init }; return response({ success: true, hostname: 'radardeleiloes.app.br', action: 'cadastro' }); }) as ChallengeFetch,
  });
  assert.deepEqual(await service.verify('cadastro', 'token-secret-value'), { ok: true });
  assert.equal(call?.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(call?.init?.method, 'POST');
  assert.equal((call?.init?.headers as Record<string, string>)['content-type'], 'application/json');
  const payload = JSON.parse(String(call?.init?.body));
  assert.deepEqual(Object.keys(payload).sort(), ['idempotency_key', 'response', 'secret']);
  assert.equal(payload.secret, 'server-secret');
  assert.equal(payload.response, 'token-secret-value');
  assert.match(payload.idempotency_key, /^[0-9a-f-]{36}$/i);
  assert.equal((call?.init?.signal as AbortSignal).aborted, false);
  assert.deepEqual(service.clientConfig(), { enabled: true, siteKey: 'public-site-key', actions: ['login', 'cadastro', 'espera'] });
});

test('invalid token, action mismatch, hostname mismatch, duplicate/replay fail closed without sensitive output', async () => {
  const results = [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, hostname: 'radardeleiloes.app.br', action: 'login' },
    { success: true, hostname: 'attacker.test', action: 'cadastro' },
  ];
  const service = createChallengeService({ config: loadChallengeConfig(validEnv()), fetch: (async () => response(results.shift())) as ChallengeFetch });
  assert.deepEqual(await service.verify('cadastro', 'replay-token'), { ok: false, kind: 'invalid' });
  assert.deepEqual(await service.verify('cadastro', 'wrong-action'), { ok: false, kind: 'invalid' });
  assert.deepEqual(await service.verify('cadastro', 'wrong-host'), { ok: false, kind: 'invalid' });
  for (const token of ['', '   ', 'x'.repeat(2049), undefined, {}]) {
    assert.deepEqual(await service.verify('cadastro', token), { ok: false, kind: 'invalid' });
  }
  assert.doesNotMatch(JSON.stringify({ ...await service.verify('cadastro', 'sensitive-token') }), /sensitive-token|server-secret|error-codes/);
});

test('timeout, malformed JSON and HTTP/provider errors become unavailable without leakage', async () => {
  const failures: ChallengeFetch[] = [
    (async () => { throw new Error('network timeout with token secret'); }) as ChallengeFetch,
    (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) as unknown as Response) as ChallengeFetch,
    (async () => response({ success: false }, false)) as ChallengeFetch,
    (async () => response({ success: 'true' })) as ChallengeFetch,
  ];
  for (const fetch of failures) {
    const service = createChallengeService({ config: loadChallengeConfig(validEnv()), fetch });
    const result = await service.verify('login', 'never-echo-token');
    assert.deepEqual(result, { ok: false, kind: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(result), /never-echo-token|server-secret|timeout/);
  }
});

test('no queue: pending verification holds one of two slots until provider promise settles', async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  const service = createChallengeService({
    config: loadChallengeConfig(validEnv()),
    fetch: (async () => { calls++; if (calls === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; }); return response({ success: true, hostname: 'radardeleiloes.app.br', action: 'login' }); }) as ChallengeFetch,
  });
  const first = service.verify('login', 'first');
  const second = service.verify('login', 'second');
  assert.equal(calls, 2);
  assert.deepEqual(await service.verify('login', 'third'), { ok: false, kind: 'unavailable' });
  resolveFirst(response({ success: true, hostname: 'radardeleiloes.app.br', action: 'login' }));
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(await service.verify('login', 'fourth'), { ok: true });
});

test('Fastify preHandler maps only exact POST actions and blocks business effects with no-store responses', async () => {
  const app = Fastify({ bodyLimit: 16 * 1024 });
  let verified: string[] = [];
  let effects = 0;
  const hook = createChallengeHook({
    verify: async (action: any, token: unknown) => {
      verified.push(`${action}:${String(token)}`);
      return token === 'valid' ? { ok: true } : { ok: false, kind: 'invalid' };
    },
  });
  for (const path of ['/api/login', '/api/cadastro', '/api/espera']) {
    app.post(path, { preHandler: hook }, async () => { effects++; return { ok: true }; });
  }
  app.post('/api/other', { preHandler: hook }, async () => { effects++; return { ok: true }; });

  for (const [path, action] of [['/api/login', 'login'], ['/api/cadastro', 'cadastro'], ['/api/espera', 'espera']] as const) {
    const response = await app.inject({ method: 'POST', url: `${path}?action=espera`, payload: { turnstileToken: 'bad' } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { error: 'challenge_failed' });
    assert.equal(verified.at(-1)?.split(':')[0], action, 'action comes from exact server route, not query');
  }
  const good = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { turnstileToken: 'valid' } });
  assert.equal(good.statusCode, 200, 'anonymous legitimate signup can pass challenge without account auth');
  assert.equal(effects, 1);
  const other = await app.inject({ method: 'POST', url: '/api/other', payload: { turnstileToken: 'bad' } });
  assert.equal(other.statusCode, 200, 'unlisted route is not challenged by hook');
  const oversized = await app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'x'.repeat(17 * 1024) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(effects, 2);
  assert.equal(verified.some((entry) => entry.includes('x'.repeat(20))), false);
  await app.close();
});

test('unavailable provider response blocks route effects with retry-after and no-store', async () => {
  const app = Fastify({ bodyLimit: 16 * 1024 });
  let effects = 0;
  const service = createChallengeService({ config: loadChallengeConfig(validEnv()), fetch: (async () => { throw new Error('provider down'); }) as ChallengeFetch });
  app.post('/api/login', { preHandler: createChallengeHook(service) }, async () => { effects++; return { ok: true }; });
  const result = await app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'valid-shaped-token' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['retry-after'], '3');
  assert.deepEqual(result.json(), { error: 'challenge_unavailable', retryAfterSeconds: 3 });
  assert.equal(effects, 0);
  await app.close();
});
