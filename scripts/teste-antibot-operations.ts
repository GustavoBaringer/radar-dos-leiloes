import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { loadAntibotConfig } from '../src/core/antibot/config.js';
import { createAntibot, createDefaultObserver } from '../src/core/antibot/engine.js';
import { registerAntibot } from '../src/core/antibot/fastify.js';
import { loadProxyTrustConfig } from '../src/core/antibot/proxy.js';
import { composeOperationsObserver, createOperationsTelemetry } from '../src/core/antibot/telemetry.js';
import { registerOperationsMetricsRoute, ROUTE_POLICIES } from '../src/core/antibot/routes.js';
import type { AntibotEvent } from '../src/core/antibot/types.js';

test('proxy config defaults disabled; rejects unsafe, malformed, oversized CIDRs and requires production acknowledgement', () => {
  assert.deepEqual(loadProxyTrustConfig({ NODE_ENV: 'test' }), {
    trustedProxyCidrs: [], trustProxy: false, originProtectionConfirmed: false,
  });
  for (const value of ['true', '*', '0.0.0.0/0', '::/0', '0.0.0.0', '::', '192.0.2.1/33', '2001:db8::1/129', '192.0.2.0/abc', '192.0.2.0/24/2']) {
    assert.throws(() => loadProxyTrustConfig({ NODE_ENV: 'test', ANTIBOT_TRUST_PROXY_CIDRS: value }), /ANTIBOT_TRUST_PROXY_CIDRS/);
  }
  assert.throws(() => loadProxyTrustConfig({ NODE_ENV: 'test', ANTIBOT_TRUST_PROXY_CIDRS: Array(21).fill('192.0.2.1').join(',') }), /20 entradas/);
  assert.throws(() => loadProxyTrustConfig({ NODE_ENV: 'production', ANTIBOT_TRUST_PROXY_CIDRS: '192.0.2.0/24' }), /ORIGIN_PROTECTION_CONFIRMED/);
  assert.deepEqual(loadProxyTrustConfig({
    NODE_ENV: 'production', ANTIBOT_TRUST_PROXY_CIDRS: '192.0.2.0/24,2001:db8::1', ANTIBOT_ORIGIN_PROTECTION_CONFIRMED: '1',
  }).trustedProxyCidrs, ['192.0.2.0/24', '2001:db8::1']);
});

test('Fastify inject ignores spoofed forwarding by default and trusts only configured peer chain', async () => {
  async function appFor(env: NodeJS.ProcessEnv) {
    const config = loadProxyTrustConfig(env);
    const app = Fastify({ trustProxy: config.trustedProxyCidrs.length ? [...config.trustedProxyCidrs] : false });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    return app;
  }
  const noTrust = await appFor({ NODE_ENV: 'test' });
  const spoofIgnored = await noTrust.inject({
    method: 'GET', url: '/ip', remoteAddress: '198.51.100.20', headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  assert.deepEqual(spoofIgnored.json(), { ip: '198.51.100.20' });
  await noTrust.close();

  const trusted = await appFor({ NODE_ENV: 'test', ANTIBOT_TRUST_PROXY_CIDRS: '127.0.0.1/32' });
  const peerChain = await trusted.inject({
    method: 'GET', url: '/ip', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.20' },
  });
  assert.deepEqual(peerChain.json(), { ip: '198.51.100.20' }, 'trusted loopback proxy is followed only to nearest untrusted hop, not spoofed leftmost client value');
  const untrustedPeer = await trusted.inject({
    method: 'GET', url: '/ip', remoteAddress: '198.51.100.21', headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  assert.deepEqual(untrustedPeer.json(), { ip: '198.51.100.21' });
  await trusted.close();
});

test('production rejects broad proxy coverage and narrow CIDRs never accept forged XFF', async () => {
  const production = { NODE_ENV: 'production', ANTIBOT_ORIGIN_PROTECTION_CONFIRMED: '1' };
  for (const broad of ['::ffff:0.0.0.0/96', '::ffff:0:0/96', '0.0.0.0/0', '::/0']) {
    assert.throws(
      () => loadProxyTrustConfig({ ...production, ANTIBOT_TRUST_PROXY_CIDRS: broad }),
      /ANTIBOT_TRUST_PROXY_CIDRS/,
      `broad entry ${broad} must not be configurable even with acknowledgement`,
    );
  }
  const config = loadProxyTrustConfig({
    ...production, ANTIBOT_TRUST_PROXY_CIDRS: '10.0.0.0/8,::ffff:203.0.113.0/120',
  });
  assert.deepEqual(config.trustedProxyCidrs, ['10.0.0.0/8', '::ffff:203.0.113.0/120']);
  assert.deepEqual(config.trustProxy, ['10.0.0.0/8', '::ffff:203.0.113.0/120']);

  const app = Fastify({ trustProxy: [...config.trustedProxyCidrs] });
  app.get('/ip', async (request) => ({ ip: request.ip }));
  const forgedIpv4 = await app.inject({
    method: 'GET', url: '/ip', remoteAddress: '198.51.100.30', headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  assert.deepEqual(forgedIpv4.json(), { ip: '198.51.100.30' }, 'untrusted peer cannot inject a client IP');
  const forgedMapped = await app.inject({
    method: 'GET', url: '/ip', remoteAddress: '::ffff:198.51.100.31', headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  assert.equal(
    String(forgedMapped.json().ip).replace(/^::ffff:/, ''),
    '198.51.100.31',
    'peer outside the configured mapped subnet keeps its own address',
  );
  const narrowTrust = await app.inject({
    method: 'GET', url: '/ip', remoteAddress: '10.0.0.5',
    headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.32' },
  });
  assert.deepEqual(narrowTrust.json(), { ip: '198.51.100.32' }, 'trusted narrow peer resolves only to nearest untrusted hop');
  await app.close();
});

test('telemetry has closed finite labels, bounded series, saturating counters and observed degradation', () => {
  const telemetry = createOperationsTelemetry({ antibotMode: 'enforce', challengeMode: 'enforce', proxyTrustConfigured: false });
  const denied: AntibotEvent = { type: 'denied', policy: 'search', reason: 'quota', source: 'redis', mode: 'enforce' };
  for (let i = 0; i < 10_000; i++) telemetry.observeAntibot(denied);
  telemetry.observeAntibot({ type: 'degraded', reason: 'redis_error', mode: 'enforce' });
  telemetry.observeWs('capacity', 'denied');
  telemetry.observeChallenge('cadastro', 'unavailable', 3_500);
  let snapshot = telemetry.snapshot();
  assert.equal(snapshot.counters.length, 4);
  assert.ok(snapshot.counters.length <= 512);
  assert.equal(snapshot.counters.find((counter) => counter.series === 'foundation.denied.enforce.search.quota.redis')?.count, 10_000);
  assert.equal(snapshot.degraded.observed, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /203\.0\.113|userId|token|secret|redis:\/\/|https?:\/\//i);
  telemetry.observeAntibot({ type: 'recovered', mode: 'enforce' });
  snapshot = telemetry.snapshot();
  assert.equal(snapshot.degraded.observed, false);
});

test('composed observer retains bounded logger behavior; throwing observer cannot change quota decisions', async () => {
  const telemetry = createOperationsTelemetry({ antibotMode: 'enforce', challengeMode: 'off', proxyTrustConfigured: false });
  const oldWarn = console.warn;
  let emitted = 0;
  console.warn = () => { emitted++; };
  try {
    const observer = composeOperationsObserver(telemetry, createDefaultObserver());
    const driver = { async check() { return { allowed: false, ttlMs: 1000 }; }, async ping() {}, async close() {} };
    const antibot = createAntibot({ config: loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'enforce' }), driver, observer });
    let decision;
    for (let i = 0; i < 1000; i++) decision = await antibot.check('search', { type: 'account', id: 7 });
    assert.equal(decision?.allowed, false);
    assert.equal(emitted, 10, 'existing bounded log series remains at ten events/minute');
    assert.equal(telemetry.snapshot().counters[0].count, 1000);
    await antibot.close();
  } finally { console.warn = oldWarn; }

  const throwingObserver = composeOperationsObserver({ observeAntibot() { throw new Error('observer'); } }, () => { throw new Error('logger'); });
  const antibot = createAntibot({
    config: loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'enforce' }),
    driver: { async check() { return { allowed: false, ttlMs: 500 }; }, async ping() {}, async close() {} },
    observer: throwingObserver,
  });
  assert.equal((await antibot.check('search', { type: 'account', id: 8 })).allowed, false);
  await antibot.close();
});

test('metrics route requires authenticated admin, uses search/account quota policy, no-store, and exposes safe snapshot', async () => {
  assert.equal(ROUTE_POLICIES['GET /api/security/metrics'], 'search');
  assert.equal(ROUTE_POLICIES['HEAD /api/security/metrics'], 'search');
  const app = Fastify();
  await registerAntibot(app, { config: loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'off' }) });
  const telemetry = createOperationsTelemetry({ antibotMode: 'off', challengeMode: 'off', proxyTrustConfigured: false });
  telemetry.observeChallenge('login', 'success', 18);
  registerOperationsMetricsRoute(app, telemetry);
  // Mirrors the server's authenticated identity hook while exercising the live metrics registrar.
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-fixture-role'];
    if (role === 'admin' || role === 'user') {
      (request as any).eu = { userId: role === 'admin' ? 11 : 12 };
      (request as any).papel = role;
    }
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/security/metrics' })).statusCode, 401);
  const denied = await app.inject({ method: 'GET', url: '/api/security/metrics', headers: { 'x-fixture-role': 'user' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['cache-control'], 'no-store');
  const admin = await app.inject({ method: 'GET', url: '/api/security/metrics', headers: { 'x-fixture-role': 'admin' } });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.headers['cache-control'], 'no-store');
  assert.deepEqual(admin.json(), {
    modes: { antibot: 'off', challenge: 'off', proxyTrust: 'disabled' },
    degraded: { observed: false },
    counters: [{ series: 'challenge.login.success.lt50ms', count: 1 }],
  });
  assert.doesNotMatch(admin.body, /secret|token|redis:\/\/|198\.51\.100/);
  await app.close();
});
