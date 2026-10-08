import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { registerAntibot } from '../src/core/antibot/fastify.js';
import { loadAntibotConfig } from '../src/core/antibot/config.js';
import { ROUTE_POLICIES } from '../src/core/antibot/routes.js';
import { createResourcePool } from '../src/core/antibot/resources.js';
import { createHttpResourceGuard } from '../src/core/antibot/http-resources.js';
import { createWsProtection } from '../src/core/antibot/ws.js';
import { admitWsUpgrade, attachWsUpgrade } from '../src/core/antibot/ws-admission.js';
import { parseSearchInput, safePositiveId, BoundedInputError } from '../src/core/request-bounds.js';
import { toPublicAlert, toPublicFavorite, toPublicHit, toPublicLot } from '../src/core/public-dto.js';

const config = () => loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'off' });

test('Fastify account route requires resolved positive account even when quotas are off', async () => {
  const app = Fastify({ trustProxy: false, bodyLimit: 16 * 1024 });
  await registerAntibot(app, { config: config() });
  app.get('/api/search', async () => ({ ok: true }));
  app.get('/api/vitrine', async () => ({ public: true }));
  const protectedResponse = await app.inject({ method: 'GET', url: '/api/search' });
  assert.equal(protectedResponse.statusCode, 401);
  assert.equal(protectedResponse.headers['cache-control'], 'no-store');
  const publicResponse = await app.inject({ method: 'GET', url: '/api/vitrine' });
  assert.equal(publicResponse.statusCode, 200);
  await app.close();
});

test('Fastify account subject uses authenticated user id and never forwarded IP', async () => {
  const app = Fastify({ trustProxy: false });
  await registerAntibot(app, { config: config() });
  app.addHook('onRequest', async (request) => { (request as any).eu = { userId: 83 }; });
  app.get('/api/search', async (request) => ({ userId: (request as any).eu.userId, ip: request.ip }));
  const response = await app.inject({
    method: 'GET', url: '/api/search', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.8' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { userId: 83, ip: '127.0.0.1' });
  await app.close();
});

test('policy mapping is exact by route template and covers aliases and write routes', () => {
  assert.equal(ROUTE_POLICIES['HEAD /api/search'], 'search');
  assert.equal(ROUTE_POLICIES['GET /api/me'], 'search');
  assert.equal(ROUTE_POLICIES['GET /api/brands'], 'search');
  assert.equal(ROUTE_POLICIES['GET /api/explain'], 'search');
  assert.equal(ROUTE_POLICIES['GET /api/malha/:tipo'], 'search');
  assert.equal(ROUTE_POLICIES['POST /api/alerts'], 'write');
  assert.equal(ROUTE_POLICIES['GET /ws'], 'wsIp');
  assert.equal(ROUTE_POLICIES['GET /api/stats'], undefined);
});

test('shared read resources enforce four immediate leases and release after awaited work', async () => {
  const pool = createResourcePool({ maxResources: 4, maxImageJobs: 2 });
  const held = Array.from({ length: 4 }, () => pool.tryAcquireResource()!);
  assert.equal(pool.tryAcquireResource(), null);
  held.forEach((lease) => lease.release());
  pool.tryAcquireResource()!.release();

  const occupied = Array.from({ length: 3 }, () => pool.tryAcquireResource()!);
  let releaseWork!: () => void;
  const guard = createHttpResourceGuard({ tryAcquireResource: pool.tryAcquireResource, acquireDegradedWork: () => ({ release() {} }) });
  const pending = guard.run({ code() { return this; }, header() { return this; }, send() {} }, () => new Promise<void>((resolve) => { releaseWork = resolve; }));
  assert.equal(pool.tryAcquireResource(), null);
  releaseWork();
  await pending;
  occupied.forEach((lease) => lease.release());
  pool.tryAcquireResource()!.release();
});

test('degraded budget exhaustion returns no-store 503 without starting route work', async () => {
  let started = false;
  let status = 0;
  const guard = createHttpResourceGuard({
    tryAcquireResource: () => ({ release() {} }),
    acquireDegradedWork: () => null,
  });
  await guard.run({
    code(value) { status = value; return this; },
    header() { return this; },
    send() {},
  }, () => { started = true; });
  assert.equal(started, false);
  assert.equal(status, 503);
});

test('bounds reject malformed scalar/id before query and serializers strip private nested data', () => {
  assert.throws(() => parseSearchInput({ page: ['1', '2'] }), BoundedInputError);
  assert.equal(safePositiveId('9007199254740992'), null);
  const source = {
    id: 1, source_id: 's', title_raw: 'lote', status: 'aberto', asset_type: 'veiculo',
    raw: { cpf: 'hidden' }, external_id: 'hidden', nested: { secret: true }, photos: ['javascript:bad'],
    bid_history: [{ bid: 5, observed_at: '2026-01-01', secret: true }],
    seen: false, hit_em: null, labels: ['a'], favorited_em: '2026-01-01',
  };
  for (const dto of [toPublicLot(source), toPublicHit(source), toPublicFavorite(source)]) {
    const json = JSON.stringify(dto);
    assert.doesNotMatch(json, /hidden|secret|javascript/);
    assert.equal('external_id' in dto, false);
  }
  assert.deepEqual(toPublicAlert({ id: 1, owner_id: 2, label: 'x', channels: ['push'], total: 0, nao_vistos: 0 }), {
    id: 1, label: 'x', q: null, channels: ['push'], email: null, total: 0, nao_vistos: 0,
  });
});

test('WS reservations have a hard local cap in off mode and release on socket close', async () => {
  const ws = createWsProtection({ mode: 'off', environment: 'test' });
  const result = await ws.reserve(9);
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  let closed = false;
  const listeners = new Map<string, (...args: any[]) => void>();
  const socket = {
    readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() { closed = true; },
    on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener); },
  };
  ws.attach(result.reservation, socket);
  listeners.get('close')?.();
  await result.reservation.release();
  assert.equal(closed, true);
  await ws.close();
});

test('plain /ws HTTP GETs never reserve; validated websocket upgrade reserves and attaches', async () => {
  const app = Fastify();
  await app.register(websocket);
  const protection = createWsProtection({ mode: 'off', environment: 'test' });
  let reserveCalls = 0;
  const originalReserve = protection.reserve;
  protection.reserve = async (id) => { reserveCalls++; return originalReserve(id); };
  app.addHook('onRequest', async (req) => { (req as any).eu = { userId: 9 }; });
  app.get('/ws', {
    websocket: true,
    preHandler: (req, reply) => admitWsUpgrade(req as any, reply, {
      protection,
      checkAccount: async () => ({ allowed: true }),
      sendUnauthenticated: (reply) => reply.code(401).send({ error: 'unauthorized' }),
      sendRateLimit: () => false,
    }),
  }, (socket, req) => { attachWsUpgrade(req as any, socket, protection); });

  for (let i = 0; i < 205; i++) {
    const response = await app.inject({ method: 'GET', url: '/ws' });
    assert.equal(response.statusCode, 404);
  }
  assert.equal(reserveCalls, 0);

  // Exercise the installed websocket plugin's actual validated upgrade path on
  // an ephemeral loopback listener; no external/network service is contacted.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const WebSocket = createRequire(import.meta.url)('ws') as any;
  const client = new WebSocket(address.replace('http:', 'ws:') + '/ws');
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  assert.equal(reserveCalls, 1);
  client.close();
  await new Promise<void>((resolve) => client.once('close', resolve));
  await protection.close();
  await app.close();
});

test('pre-upgrade abort/error/finish releases reservations idempotently and attach rejects dead reservation', async () => {
  const protection = createWsProtection({ mode: 'off', environment: 'test' });
  const requestRaw = new EventEmitter() as any;
  requestRaw.aborted = false;
  const responseRaw = new EventEmitter() as any;
  responseRaw.destroyed = false;
  responseRaw.writableFinished = false;
  const reply: any = { raw: responseRaw, code() { return this; }, header() { return this; }, send() {} };
  const req: any = { ws: true, eu: { userId: 3 }, raw: requestRaw };
  await admitWsUpgrade(req, reply, {
    protection,
    checkAccount: async () => ({ allowed: true }),
    sendUnauthenticated: () => {},
    sendRateLimit: () => false,
  });
  requestRaw.emit('aborted');
  responseRaw.emit('finish');
  let terminated = false;
  assert.equal(attachWsUpgrade(req, { terminate() { terminated = true; } }, protection), true);
  assert.equal(terminated, true, 'attach rejects reservation released by abort');

  for (const event of ['error', 'finish', 'close']) {
    const rawRequest = new EventEmitter() as any;
    rawRequest.aborted = false;
    const rawResponse = new EventEmitter() as any;
    rawResponse.destroyed = false;
    rawResponse.writableFinished = false;
    const nextReq: any = { ws: true, eu: { userId: 4 }, raw: rawRequest };
    await admitWsUpgrade(nextReq, { ...reply, raw: rawResponse }, {
      protection,
      checkAccount: async () => ({ allowed: true }),
      sendUnauthenticated: () => {},
      sendRateLimit: () => false,
    });
    if (event === 'error') rawRequest.emit(event, new Error('fixture'));
    else rawResponse.emit(event);
    let closed = false;
    attachWsUpgrade(nextReq, { terminate() { closed = true; } }, protection);
    assert.equal(closed, true, `${event} releases before attachment`);
  }
  await protection.close();
});

test('WS authentication 401 and account quota 429 stay pre-upgrade without reserving', async () => {
  const protection = createWsProtection({ mode: 'off', environment: 'test' });
  let reserveCalls = 0;
  const reserve = protection.reserve;
  protection.reserve = async (id) => { reserveCalls++; return reserve(id); };
  const makeReply = () => ({
    status: 200, headers: {} as Record<string, unknown>, body: undefined as unknown,
    code(status: number) { this.status = status; return this; },
    header(name: string, value: unknown) { this.headers[name] = value; return this; },
    send(body: unknown) { this.body = body; return this; },
  });
  const noIdentityReply = makeReply();
  await admitWsUpgrade({ ws: true, raw: new EventEmitter() as any }, noIdentityReply, {
    protection, checkAccount: async () => ({ allowed: true }),
    sendUnauthenticated: (reply) => reply.code(401).send({ error: 'unauthorized' }),
    sendRateLimit: () => false,
  });
  assert.equal(noIdentityReply.status, 401);

  const limitedReply = makeReply();
  await admitWsUpgrade({ ws: true, eu: { userId: 7 }, raw: new EventEmitter() as any }, limitedReply, {
    protection, checkAccount: async () => ({ allowed: false, status: 429 }),
    sendUnauthenticated: () => {},
    sendRateLimit: (reply, decision) => {
      if (decision.allowed) return false;
      reply.code(decision.status ?? 429).send({ error: 'rate_limited' });
      return true;
    },
  });
  assert.equal(limitedReply.status, 429);
  assert.equal(reserveCalls, 0);
  await protection.close();
});
