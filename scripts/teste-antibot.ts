import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { loadAntibotConfig } from '../src/core/antibot/config.js';
import { createAntibot } from '../src/core/antibot/engine.js';
import { normalizeClientIp } from '../src/core/antibot/ip.js';
import { registerAntibot } from '../src/core/antibot/fastify.js';
import type { AntibotConfig, AntibotEvent, Policy, PolicyId, RateLimitDriver } from '../src/core/antibot/types.js';

const config = (mode: 'off' | 'shadow' | 'enforce' = 'enforce', patch: Partial<Record<PolicyId, Partial<Policy>>> = {}): AntibotConfig => {
  const loaded = loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: mode, ANTIBOT_REDIS_URL: 'redis://127.0.0.1:6380' });
  return {
    ...loaded,
    policies: Object.fromEntries(Object.entries(loaded.policies).map(([id, p]) => [id, { ...p, ...patch[id as PolicyId] }])) as AntibotConfig['policies'],
  };
};

class MemoryDriver implements RateLimitDriver {
  readonly values = new Map<string, { count: number; expiry: number }>();
  fail = false;
  pingFailures = false;
  pingGate: Promise<void> | null = null;
  failure = 'simulated Redis failure';
  pingCount = 0;
  closeCount = 0;
  readonly fakeNow: () => number;
  constructor(now: () => number) { this.fakeNow = now; }
  async check(policy: Policy, key: string) {
    if (this.fail) throw new Error(this.failure);
    const now = this.fakeNow();
    let v = this.values.get(key);
    if (!v || now >= v.expiry) { v = { count: 0, expiry: now + policy.windowMs }; this.values.set(key, v); }
    v.count++;
    return { allowed: v.count <= policy.max, ttlMs: v.expiry - now };
  }
  async ping() { this.pingCount++; if (this.pingGate) await this.pingGate; if (this.pingFailures) throw new Error('simulated ping failure'); }
  async close() { this.closeCount++; }
}

const events: AntibotEvent[] = [];
let now = 0;
let engine: ReturnType<typeof createAntibot>;
let driver: MemoryDriver;

before(() => {
  events.length = 0;
  now = 0;
});

after(async () => { await engine?.close(); });

test('strict config, defaults, production mode and explicit production off authorization', () => {
  const base = loadAntibotConfig({ NODE_ENV: 'development' });
  assert.equal(base.mode, 'off');
  assert.equal(base.redisUrl, 'redis://localhost:6380');
  assert.deepEqual([base.policies.search.max, base.policies.search.windowMs], [30, 60_000]);
  assert.deepEqual([base.policies.mapa.max, base.policies.mapa.windowMs], [12, 60_000]);
  assert.throws(() => loadAntibotConfig({ NODE_ENV: 'production' }), /ANTIBOT_MODE obrigatório/);
  assert.throws(() => loadAntibotConfig({ NODE_ENV: 'production', ANTIBOT_MODE: 'off' }), /ANTIBOT_ALLOW_OFF/);
  assert.equal(loadAntibotConfig({ NODE_ENV: 'production', ANTIBOT_MODE: 'off', ANTIBOT_ALLOW_OFF: '1' }).mode, 'off');
  for (const bad of ['1.5', ' 2', '02', 'Infinity', '10001']) {
    assert.throws(() => loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_SEARCH_MAX: bad }), /ANTIBOT_SEARCH_MAX/);
  }
  assert.throws(() => loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_SEARCH_WINDOW_MS: '999' }), /ANTIBOT_SEARCH_WINDOW_MS/);
  assert.throws(() => loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_REDIS_URL: 'http://redis' }), /redis:\/\//);
});

test('canonical IPs, IPv4-mapped IPv6 and invalid input', () => {
  assert.equal(normalizeClientIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeClientIp('::192.0.2.1'), normalizeClientIp('::c000:201'));
  assert.equal(normalizeClientIp('::ffff:192.0.2.9'), '192.0.2.9');
  assert.equal(normalizeClientIp('::ffff:c000:209'), '192.0.2.9');
  assert.throws(() => normalizeClientIp('not-an-ip'), /inválido/);
});

test('off never connects or observes; shadow counts and observes without blocking', async () => {
  const seen: AntibotEvent[] = [];
  const off = createAntibot({ config: config('off'), observer: (event) => seen.push(event) });
  assert.deepEqual(await off.check('search', { type: 'account', id: 4 }), {
    allowed: true, wouldBlock: false, reason: 'allowed', source: 'off', retryAfterSeconds: 0,
  });
  await off.close();
  assert.equal(seen.length, 0);

  const app = Fastify({ logger: false });
  const registration = await registerAntibot(app, { config: config('off'), observer: (event) => seen.push(event) });
  app.get('/api/vitrine', async () => ({ ok: true }));
  assert.equal((await app.inject('/api/vitrine')).statusCode, 200);
  await app.close();
  assert.equal(seen.length, 0);
  await registration.close();

  now = 0;
  driver = new MemoryDriver(() => now);
  engine = createAntibot({ config: config('shadow', { search: { max: 1 } }), driver, clock: () => now, observer: (event) => seen.push(event) });
  assert.equal((await engine.check('search', { type: 'account', id: 2 })).allowed, true);
  const over = await engine.check('search', { type: 'account', id: 2 });
  assert.deepEqual([over.allowed, over.wouldBlock, over.reason], [true, true, 'quota']);
  assert.equal(seen.some((e) => e.type === 'denied' && e.policy === 'search'), true);
});

test('shadow storage failure never blocks quota, cap, budget or lease, including inject', async (t) => {
  now = 0;
  const observed: AntibotEvent[] = [];
  driver = new MemoryDriver(() => now);
  driver.fail = true;
  engine = createAntibot({ config: config('shadow', { search: { max: 1 } }), driver, clock: () => now, observer: (event) => observed.push(event) });
  const first = await engine.check('search', { type: 'account', id: 1 });
  const quota = await engine.check('search', { type: 'account', id: 1 });
  assert.deepEqual([first.allowed, first.source], [true, 'fallback']);
  assert.deepEqual([quota.allowed, quota.wouldBlock, quota.reason], [true, true, 'quota']);
  for (let i = 2; i <= 1024; i++) {
    const decision = await engine.check('search', { type: 'account', id: i });
    assert.equal(decision.allowed, true);
  }
  const cap = await engine.check('search', { type: 'account', id: 1025 });
  assert.deepEqual([cap.allowed, cap.wouldBlock, cap.reason], [true, true, 'capacity']);
  const budget = await engine.check('detail', { type: 'account', id: 5000 });
  assert.deepEqual([budget.allowed, budget.wouldBlock, budget.reason], [true, true, 'degraded_budget']);
  const lease = engine.acquireDegradedWork();
  assert.ok(lease);
  lease.release(); lease.release();
  assert.equal(observed.some((event) => event.type === 'denied' && event.reason === 'capacity'), true);

  const app = Fastify({ logger: false });
  const fallback = new MemoryDriver(() => now);
  fallback.fail = true;
  const registered = await registerAntibot(app, {
    config: config('shadow', { vitrine: { max: 1 } }), driver: fallback, clock: () => now,
    observer: (event) => observed.push(event),
  });
  app.get('/api/vitrine', async () => ({ ok: true }));
  t.after(() => app.close());
  assert.equal((await app.inject('/api/vitrine')).statusCode, 200);
  assert.equal((await app.inject('/api/vitrine')).statusCode, 200);
  assert.equal(observed.some((event) => event.type === 'denied' && event.policy === 'vitrine'), true);
  await registered.close();
});

test('fixed window N/N+1, exact expiry, non-renewing TTL and concurrent increments', async () => {
  now = 0;
  driver = new MemoryDriver(() => now);
  engine = createAntibot({ config: config('enforce', { search: { max: 2, windowMs: 1_000 } }), driver, clock: () => now, observer: (event) => events.push(event) });
  const subject = { type: 'account' as const, id: 10 };
  const first = await engine.check('search', subject);
  now = 700;
  const second = await engine.check('search', subject);
  assert.equal(first.allowed && second.allowed, true);
  now = 999;
  const denied = await engine.check('search', subject);
  assert.deepEqual([denied.allowed, denied.retryAfterSeconds], [false, 1]);
  now = 1_000;
  assert.equal((await engine.check('search', subject)).allowed, true);

  const concurrent = await Promise.all(Array.from({ length: 3 }, () => engine.check('search', { type: 'account', id: 11 })));
  assert.equal(concurrent.filter((d) => d.allowed).length, 2);
});

test('subjects and groups are isolated; anonymous id zero rejected; admin receives no bypass', async () => {
  now = 0;
  driver = new MemoryDriver(() => now);
  engine = createAntibot({ config: config('enforce', { search: { max: 1 }, detail: { max: 1 } }), driver, clock: () => now });
  assert.equal((await engine.check('search', { type: 'account', id: 7 })).allowed, true);
  assert.equal((await engine.check('search', { type: 'account', id: 7 })).allowed, false);
  assert.equal((await engine.check('search', { type: 'account', id: 8 })).allowed, true);
  assert.equal((await engine.check('detail', { type: 'account', id: 7 })).allowed, true);
  await assert.rejects(engine.check('search', { type: 'account', id: 0 }), /inteiro positivo/);
  await assert.rejects(engine.check('vitrine', { type: 'account', id: 7 }), /exige identidade/);
});

test('lease is no-op healthy, stays degraded while probe pending, and sees recovery between check/acquire', async () => {
  now = 0;
  driver = new MemoryDriver(() => now); driver.fail = true;
  const base = config('enforce');
  const short = { ...base, policies: Object.fromEntries(Object.entries(base.policies).map(([id, p]) => [id, { ...p, windowMs: 1_000 }])) as AntibotConfig['policies'] };
  engine = createAntibot({ config: short, driver, clock: () => now, observer: () => {} });
  const healthy = engine.acquireDegradedWork();
  assert.ok(healthy);
  healthy.release(); healthy.release();
  await engine.check('search', { type: 'account', id: 1 });
  now = 1_000;
  driver.fail = false;
  let resolvePing!: () => void;
  driver.pingGate = new Promise<void>((resolve) => { resolvePing = resolve; });
  await engine.check('search', { type: 'account', id: 2 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(driver.pingCount, 1);
  const lease1 = engine.acquireDegradedWork();
  const lease2 = engine.acquireDegradedWork();
  assert.ok(lease1 && lease2);
  assert.equal(engine.acquireDegradedWork(), null);
  lease1.release(); lease2.release();

  resolvePing();
  driver.pingGate = null;
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Recovery may win between the check and lease acquisition; healthy yields a no-op lease, never a false denial.
  const afterRecovery = engine.acquireDegradedWork();
  assert.ok(afterRecovery);
  afterRecovery.release();
});

test('fallback is bounded, does not evict live entries, shares admission budget and leases', async () => {
  now = 0;
  driver = new MemoryDriver(() => now);
  driver.fail = true;
  engine = createAntibot({ config: config('enforce', { vitrine: { max: 2, windowMs: 3_600_000 } }), driver, clock: () => now, observer: (event) => events.push(event) });
  const first = await engine.check('vitrine', { type: 'ip', value: '192.0.2.1' });
  assert.equal(first.source, 'fallback');
  const lease1 = engine.acquireDegradedWork();
  const lease2 = engine.acquireDegradedWork();
  assert.ok(lease1 && lease2);
  assert.equal(engine.acquireDegradedWork(), null);
  lease1.release(); lease1.release(); lease2.release();
  const lease3 = engine.acquireDegradedWork();
  assert.ok(lease3);
  lease3.release();

  for (let i = 2; i <= 1024; i++) await engine.check('vitrine', { type: 'ip', value: `198.51.${Math.floor(i / 256)}.${i % 256}` });
  const full = await engine.check('vitrine', { type: 'ip', value: '203.0.113.1' });
  assert.deepEqual([full.allowed, full.reason], [false, 'capacity']);
  now = 60_000;
  const existing = await engine.check('vitrine', { type: 'ip', value: '192.0.2.1' });
  assert.notEqual(existing.reason, 'capacity');
  assert.equal(events.some((e) => e.type === 'saturated' && e.area === 'leases'), true);
});

test('fallback capacity is per policy and releases subjects at exact expiry', async () => {
  now = 0;
  driver = new MemoryDriver(() => now); driver.fail = true;
  engine = createAntibot({ config: config('enforce', { cadastro: { windowMs: 3_600_000 } }), driver, clock: () => now, observer: () => {} });
  for (let i = 1; i <= 1024; i++) await engine.check('cadastro', { type: 'ip', value: `192.0.${Math.floor(i / 256)}.${i % 256}` });
  assert.equal((await engine.check('cadastro', { type: 'ip', value: '198.51.100.1' })).reason, 'capacity');
  now = 60_000;
  assert.equal((await engine.check('search', { type: 'account', id: 1 })).allowed, true);

  now = 0;
  driver = new MemoryDriver(() => now); driver.fail = true;
  const base = config('enforce', { search: { max: 10_000 } });
  const short = { ...base, policies: Object.fromEntries(Object.entries(base.policies).map(([id, p]) => [id, { ...p, max: 10_000, windowMs: 60_000 }])) as AntibotConfig['policies'] };
  engine = createAntibot({ config: short, driver, clock: () => now, observer: () => {} });
  for (let i = 1; i <= 1024; i++) await engine.check('search', { type: 'account', id: i });
  assert.equal((await engine.check('search', { type: 'account', id: 1025 })).reason, 'capacity');
  now = 60_000;
  const afterExpiry = await engine.check('search', { type: 'account', id: 1025 });
  assert.deepEqual([afterExpiry.allowed, afterExpiry.reason], [true, 'allowed']);
});

test('default observer bounds output by finite labels and reports suppressed events', async () => {
  now = 0;
  driver = new MemoryDriver(() => now);
  driver.fail = true;
  const writes: string[] = [];
  const oldWarn = console.warn;
  console.warn = (...args: unknown[]) => { writes.push(String(args[1])); };
  try {
    engine = createAntibot({ config: config('enforce', { search: { max: 1 } }), driver, clock: () => now });
    for (let i = 0; i < 2_000; i++) await engine.check('search', { type: 'account', id: 1 });
    assert.ok(writes.length <= 12, `log emissions=${writes.length}`);
    now = 60_000;
    await engine.check('search', { type: 'account', id: 1 });
    await engine.check('search', { type: 'account', id: 1 });
    const summaries = writes.map((line) => JSON.parse(line) as { suppressed: number }).filter((entry) => entry.suppressed > 0);
    assert.ok(summaries.length > 0);
    assert.ok(summaries.every((entry) => entry.suppressed > 0));
  } finally {
    console.warn = oldWarn;
  }
});

test('degradation budget is 60 per process/60s; errors alarm without identity data', async () => {
  now = 0;
  const observed: AntibotEvent[] = [];
  driver = new MemoryDriver(() => now); driver.fail = true;
  engine = createAntibot({ config: config('enforce', { search: { max: 100 } }), driver, clock: () => now, observer: (event) => observed.push(event) });
  const decisions = await Promise.all(Array.from({ length: 61 }, (_, i) => engine.check('search', { type: 'account', id: i + 1 })));
  assert.equal(decisions.filter((d) => d.allowed).length, 60);
  assert.equal(decisions[60].reason, 'degraded_budget');
  assert.equal((await engine.check('vitrine', { type: 'ip', value: '192.0.2.99' })).reason, 'degraded_budget');
  const serialized = JSON.stringify(observed);
  assert.equal(serialized.includes('account'), false);
  assert.equal(serialized.includes('1'), false);
  assert.equal(observed.some((event) => event.type === 'error'), true);
});

test('Redis command timeout and OOM use bounded fallback instead of escaping', async () => {
  for (const reason of ['command timeout', 'OOM command not allowed']) {
    now = 0;
    const observed: AntibotEvent[] = [];
    const unavailable = new MemoryDriver(() => now);
    unavailable.fail = true;
    unavailable.failure = reason;
    const bounded = createAntibot({
      config: config('enforce'), driver: unavailable, clock: () => now,
      observer: (event) => observed.push(event),
    });
    const result = await bounded.check('search', { type: 'account', id: 900 });
    assert.equal(result.source, 'fallback');
    assert.equal(result.allowed, true);
    assert.equal(observed.some((event) => event.type === 'error' && event.area === 'redis'), true);
    await bounded.close();
  }
});

test('recovery is single-flight, spaced, successful command required, and does not reset budget early', async () => {
  now = 0;
  driver = new MemoryDriver(() => now); driver.fail = true;
  const shortWindows = config('enforce', { search: { max: 100 } });
  const shortConfig = { ...shortWindows, policies: Object.fromEntries(Object.entries(shortWindows.policies).map(([id, p]) => [id, { ...p, windowMs: 1_000 }])) as AntibotConfig['policies'] };
  engine = createAntibot({ config: shortConfig, driver, clock: () => now });
  for (let i = 1; i <= 60; i++) await engine.check('search', { type: 'account', id: i });
  now = 1_000;
  driver.fail = false;
  driver.pingFailures = true;
  await Promise.all([engine.check('search', { type: 'account', id: 61 }), engine.check('search', { type: 'account', id: 62 })]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(driver.pingCount, 1);
  driver.pingFailures = false;
  now += 1_000;
  await engine.check('search', { type: 'account', id: 63 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(driver.pingCount, 2);
  assert.equal((await engine.check('search', { type: 'account', id: 64 })).source, 'redis');
  driver.fail = true;
  const preserved = await engine.check('search', { type: 'account', id: 65 });
  assert.deepEqual([preserved.allowed, preserved.reason], [false, 'degraded_budget']);
});

test('Fastify.inject shares detail group across SSR/API, separates accounts, ignores forwarded spoofing and emits JSON 429', async (t) => {
  const app = Fastify({ logger: false });
  const cfg = config('enforce', { detail: { max: 1 }, vitrine: { max: 1 } });
  const calls: string[] = [];
  const fake: RateLimitDriver = {
    async check(policy, key) {
      calls.push(key);
      const value = driver.values.get(key);
      const count = (value?.count ?? 0) + 1;
      driver.values.set(key, { count, expiry: value?.expiry ?? now + policy.windowMs });
      return { allowed: count <= policy.max, ttlMs: 2_345 };
    },
    async ping() {}, async close() {},
  };
  now = 0; driver = new MemoryDriver(() => now);
  const registered = await registerAntibot(app, { config: cfg, driver: fake, clock: () => now, observer: () => {} });
  app.addHook('onRequest', async (req) => {
    (req as FastifyRequest & { eu: { userId: number } }).eu = { userId: Number(req.headers['x-user'] ?? 42) };
  });
  app.get('/lote/:slug', async () => ({ ok: true }));
  app.get('/api/lot/:id', async () => ({ ok: true }));
  app.get('/api/vitrine', async () => ({ ok: true }));
  t.after(() => app.close());

  assert.equal((await app.inject({ method: 'GET', url: '/lote/abc', headers: { 'x-user': '9' } })).statusCode, 200);
  const shared = await app.inject({ method: 'GET', url: '/api/lot/1', headers: { 'x-user': '9' } });
  assert.equal(shared.statusCode, 429);
  assert.deepEqual(shared.json(), { error: 'rate_limited', retryAfterSeconds: 3 });
  assert.equal(shared.headers['retry-after'], '3');
  assert.equal(shared.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/api/lot/1', headers: { 'x-user': '10' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'HEAD', url: '/lote/head', headers: { 'x-user': '11' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/lot/2', headers: { 'x-user': '11' } })).statusCode, 429);

  const ipCallStart = calls.length;
  assert.equal((await app.inject({ method: 'GET', url: '/api/vitrine', headers: { 'x-forwarded-for': '203.0.113.8' } })).statusCode, 200);
  const spoofed = await app.inject({ method: 'GET', url: '/api/vitrine', headers: { 'x-forwarded-for': '198.51.100.44' } });
  assert.equal(spoofed.statusCode, 429);
  assert.equal(calls.every((key) => !key.includes('203.0.113.8') && !key.includes('198.51.100.44')), true);
  assert.equal(calls[ipCallStart], calls[ipCallStart + 1]);
  await registered.close();
});

test('Fastify adapter never converts anonymous identity to IP and does not exempt admin', async (t) => {
  const app = Fastify({ logger: false });
  now = 0; driver = new MemoryDriver(() => now);
  const registered = await registerAntibot(app, { config: config('enforce', { search: { max: 1 } }), driver, clock: () => now, observer: () => {} });
  app.addHook('onRequest', async (req, reply) => {
    const userId = Number(req.headers['x-user'] ?? 0);
    (req as FastifyRequest & { eu: { userId: number } }).eu = { userId };
    if (userId === 0) return reply.code(401).send({ error: 'não autenticado' });
  });
  app.get('/api/search', async () => ({ ok: true }));
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/api/search' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/search', headers: { 'x-user': '44' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/search', headers: { 'x-user': '44', 'x-role': 'admin' } })).statusCode, 429);
  await registered.close();
});
