import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { loadAntibotConfig } from '../src/core/antibot/config.js';
import { registerAntibot } from '../src/core/antibot/fastify.js';
import { createChallengeService, loadChallengeConfig, type ChallengeFetch } from '../src/core/antibot/challenge.js';
import { registerChallengeHttp, ROUTE_POLICIES } from '../src/core/antibot/routes.js';

const fetchJson = (result: unknown): Response => ({ ok: true, json: async () => result }) as Response;
const challengeEnv = (mode: 'off' | 'enforce') => ({
  NODE_ENV: 'test', ANTIBOT_CHALLENGE_MODE: mode,
  TURNSTILE_SITE_KEY: 'site-key-public', TURNSTILE_SECRET_KEY: 'secret-must-never-leak',
});

async function fixture(options: {
  challengeMode?: 'off' | 'enforce';
  fetch?: ChallengeFetch;
  denyIp?: () => boolean;
} = {}) {
  const app = Fastify({ bodyLimit: 16 * 1024 });
  const antibotMode = options.denyIp ? 'enforce' : 'off';
  await registerAntibot(app, {
    config: loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: antibotMode }),
    observer: () => {},
    ...(options.denyIp ? { driver: {
      async check(policy) { assert.equal(policy.identity, 'ip'); return { allowed: !options.denyIp!(), ttlMs: 3000 }; },
      async ping() {}, async close() {},
    } } : {}),
  });
  const service = createChallengeService({
    config: loadChallengeConfig(challengeEnv(options.challengeMode ?? 'enforce')),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  registerChallengeHttp(app, service, (reply, file) => reply.type(file.endsWith('.css') ? 'text/css' : 'application/javascript').send(`asset:${file}`));
  let writes = 0;
  for (const path of ['/api/login', '/api/cadastro', '/api/espera']) {
    app.post(path, async (_request, reply) => { writes++; return reply.send({ ok: true }); });
  }
  return { app, service, writes: () => writes };
}

test('live challenge adapter in off mode bypasses verification and exposes only public disabled config/assets', async () => {
  let calls = 0;
  const { app, writes } = await fixture({ challengeMode: 'off', fetch: (async () => { calls++; throw Error('must not call'); }) as ChallengeFetch });
  const config = await app.inject({ method: 'GET', url: '/api/security-config' });
  assert.equal(config.statusCode, 200);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.deepEqual(config.json(), { enabled: false, siteKey: null, actions: ['login', 'cadastro', 'espera'] });
  assert.doesNotMatch(config.body, /secret-must-never-leak|TURNSTILE_SECRET_KEY/);
  const anonSignup = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { email: 'guest@example.test' } });
  assert.equal(anonSignup.statusCode, 200);
  assert.equal(writes(), 1);
  assert.equal(calls, 0);
  for (const [path, body] of [
    ['/challenge.js', 'asset:challenge.js'], ['/challenge.css', 'asset:challenge.css'],
    ['/landing-antibot.js', 'asset:landing-antibot.js'], ['/landing-antibot.html', 'asset:landing-antibot.html'],
  ]) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, body);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/secret-must-never-leak' })).statusCode, 404);
  await app.close();
});

test('live adapter verifies successful token for each exact route; client query cannot choose action', async () => {
  const payloads: any[] = [];
  const { app, writes } = await fixture({
    fetch: (async (_url: any, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      payloads.push(payload);
      return fetchJson({ success: true, hostname: 'radardeleiloes.app.br', action: payload.response });
    }) as ChallengeFetch,
  });
  for (const [action, route] of [['login', '/api/login'], ['cadastro', '/api/cadastro'], ['espera', '/api/espera']] as const) {
    const result = await app.inject({ method: 'POST', url: `${route}?action=login`, payload: { turnstileToken: action } });
    assert.equal(result.statusCode, 200);
  }
  assert.equal(writes(), 3);
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads.map(({ response: token }) => token), ['login', 'cadastro', 'espera']);
  for (const payload of payloads) assert.equal(payload.secret, 'secret-must-never-leak');
  await app.close();
});

test('invalid/replayed tokens and wrong provider action or hostname return 403 before side effects', async () => {
  const { app, writes } = await fixture({ fetch: (async (_url: any, init: RequestInit) => {
    const token = JSON.parse(String(init.body)).response;
    if (token === 'replay') return fetchJson({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    return fetchJson({ success: true, hostname: token === 'wrong-host' ? 'attacker.invalid' : 'radardeleiloes.app.br', action: token === 'wrong-action' ? 'login' : 'cadastro' });
  }) as ChallengeFetch });
  for (const token of ['replay', 'wrong-action', 'wrong-host']) {
    const response = await app.inject({ method: 'POST', url: '/api/cadastro', payload: { turnstileToken: token } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { error: 'challenge_failed' });
  }
  assert.equal(writes(), 0);
  await app.close();
});

test('provider failure and saturation return no-store 503 with Retry-After before side effects', async () => {
  const unavailable = await fixture({ fetch: (async () => { throw new Error('provider unavailable'); }) as ChallengeFetch });
  const down = await unavailable.app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'valid-shaped-token' } });
  assert.equal(down.statusCode, 503);
  assert.equal(down.headers['cache-control'], 'no-store');
  assert.equal(down.headers['retry-after'], '3');
  assert.deepEqual(down.json(), { error: 'challenge_unavailable', retryAfterSeconds: 3 });
  assert.equal(unavailable.writes(), 0);
  await unavailable.app.close();

  const pending: Array<(response: Response) => void> = [];
  const saturated = await fixture({ fetch: (async () => new Promise<Response>((resolve) => pending.push(resolve))) as ChallengeFetch });
  const first = saturated.app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'one' } });
  const second = saturated.app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'two' } });
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const third = await saturated.app.inject({ method: 'POST', url: '/api/login', payload: { turnstileToken: 'three' } });
  assert.equal(third.statusCode, 503);
  assert.equal(third.headers['retry-after'], '3');
  assert.equal(saturated.writes(), 0);
  for (const resolve of pending) resolve(fetchJson({ success: true, hostname: 'radardeleiloes.app.br', action: 'login' }));
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  assert.equal(saturated.writes(), 2);
  await saturated.app.close();
});

test('security config is anonymous, no-store and protected by existing IP quota mapping', async () => {
  assert.equal(ROUTE_POLICIES['GET /api/security-config'], 'vitrine');
  assert.equal(ROUTE_POLICIES['HEAD /api/security-config'], 'vitrine');
  let deny = true;
  const { app } = await fixture({ denyIp: () => deny, challengeMode: 'off' });
  const limited = await app.inject({ method: 'GET', url: '/api/security-config', remoteAddress: '127.0.0.1' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '3');
  deny = false;
  const anonymous = await app.inject({ method: 'GET', url: '/api/security-config', remoteAddress: '127.0.0.1' });
  assert.equal(anonymous.statusCode, 200);
  assert.equal(anonymous.headers['cache-control'], 'no-store');
  assert.deepEqual(anonymous.json(), { enabled: false, siteKey: null, actions: ['login', 'cadastro', 'espera'] });
  await app.close();
});
