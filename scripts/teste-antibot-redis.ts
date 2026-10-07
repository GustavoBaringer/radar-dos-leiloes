import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { loadAntibotConfig } from '../src/core/antibot/config.js';
import { registerAntibot } from '../src/core/antibot/fastify.js';
import type { AntibotConfig } from '../src/core/antibot/types.js';

const redisUrl = process.env.ANTIBOT_TEST_REDIS_URL;

async function cleanNamespace(url: string, namespace: string) {
  const cleanup = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 500, commandTimeout: 250 });
  cleanup.on('error', () => {});
  try {
    if (cleanup.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        cleanup.once('ready', resolve);
        cleanup.once('error', reject);
      });
    }
    let cursor = '0';
    do {
      const [next, keys] = await cleanup.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await cleanup.del(...keys);
    } while (cursor !== '0');
  } finally {
    cleanup.disconnect();
  }
}

async function waitForReady(client: Redis) {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
  });
}

if (!redisUrl) {
  test('Redis real opt-in (ANTIBOT_TEST_REDIS_URL não definido)', { skip: 'opt-in; não lê .env nem valores de produção' }, () => {});
} else {
  test('RedisStore real: dois clientes compartilham quota/concurrency e expiram TTL isolado', async (t) => {
    const runId = randomUUID();
    const environment = `test-${runId}`;
    const base = loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'enforce', ANTIBOT_REDIS_URL: redisUrl });
    const config: AntibotConfig = {
      ...base,
      environment,
      policies: { ...base.policies, vitrine: { ...base.policies.vitrine, max: 5, windowMs: 2_000 } },
    };
    const namespace = `radar:antibot:v1:${environment}:enforce:`;
    const makeApp = async () => {
      const app = Fastify({ logger: false });
      const client = new Redis(redisUrl, {
        enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 500,
        commandTimeout: 250, autoResendUnfulfilledCommands: false,
      });
      await waitForReady(client);
      const registered = await registerAntibot(app, { config, redisClient: client, observer: () => {} });
      app.get('/api/vitrine', async () => ({ ok: true }));
      return { app, registered };
    };
    const a = await makeApp();
    const b = await makeApp();
    t.after(async () => {
      await Promise.all([a.app.close(), b.app.close()]);
      await cleanNamespace(redisUrl, namespace);
    });
    const result = (await a.app.inject('/api/vitrine')).statusCode;
    assert.equal(result, 200);
    assert.equal((await b.app.inject('/api/vitrine')).statusCode, 200);

    const concurrent = await Promise.all([
      a.app.inject('/api/vitrine'), b.app.inject('/api/vitrine'),
      a.app.inject('/api/vitrine'), b.app.inject('/api/vitrine'),
    ]);
    assert.equal(concurrent.filter((r) => r.statusCode === 200).length, 3, `statuses=${concurrent.map((r) => r.statusCode).join(',')} first=${result}`);
    const blocked = concurrent.find((r) => r.statusCode === 429);
    assert.ok(blocked);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.headers['cache-control'], 'no-store');
    assert.deepEqual(blocked.json(), { error: 'rate_limited', retryAfterSeconds: Number(blocked.headers['retry-after']) });

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal((await b.app.inject('/api/vitrine')).statusCode, 200);

  });

  test('real ioredis wait/reconnecting/ready/end fail fast without request listeners', async (t) => {
    const runId = randomUUID();
    const environment = `test-${runId}`;
    const base = loadAntibotConfig({ NODE_ENV: 'test', ANTIBOT_MODE: 'enforce', ANTIBOT_REDIS_URL: redisUrl });
    const config: AntibotConfig = {
      ...base,
      environment,
      policies: Object.fromEntries(Object.entries(base.policies).map(([id, p]) => [id, { ...p, windowMs: 1_000 }])) as AntibotConfig['policies'],
    };
    const namespace = `radar:antibot:v1:${environment}:enforce:`;
    let now = 0;
    const lazy = new Redis(redisUrl, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 500, commandTimeout: 250, autoResendUnfulfilledCommands: false,
    });
    const app = Fastify({ logger: false });
    const events: string[] = [];
    await registerAntibot(app, { config, redisClient: lazy, clock: () => now, observer: (event) => events.push(event.type) });
    app.get('/api/vitrine', async () => ({ ok: true }));
    t.after(async () => {
      await app.close();
      await cleanNamespace(redisUrl, namespace);
    });

    assert.equal(lazy.status, 'wait');
    const errorListeners = lazy.listenerCount('error');
    const readyListeners = lazy.listenerCount('ready');
    assert.equal(errorListeners, 1);
    const start = performance.now();
    assert.equal((await app.inject('/api/vitrine')).statusCode, 200);
    assert.ok(performance.now() - start < 500, 'status wait não deve aguardar conexão');
    for (let i = 0; i < 20; i++) await app.inject('/api/vitrine');
    assert.equal(lazy.listenerCount('error'), errorListeners);
    assert.equal(lazy.listenerCount('ready'), readyListeners);

    await lazy.connect();
    assert.equal(lazy.status, 'ready');
    now = 1_000;
    await app.inject('/api/vitrine');
    for (let i = 0; i < 50 && !events.includes('recovered'); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(events.includes('recovered'));
    assert.equal((await app.inject('/api/vitrine')).statusCode, 200);

    const ended = new Promise<void>((resolve) => lazy.once('end', resolve));
    lazy.disconnect();
    await ended;
    assert.equal(lazy.status, 'end');
    const endStart = performance.now();
    assert.equal((await app.inject('/api/vitrine')).statusCode, 200);
    assert.ok(performance.now() - endStart < 500, 'status end deve falhar rápido');
    assert.equal(lazy.listenerCount('error'), errorListeners);
    assert.equal(lazy.listenerCount('ready'), readyListeners);

    const reconnecting = new Redis('redis://127.0.0.1:6399', {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 100, commandTimeout: 100, autoResendUnfulfilledCommands: false,
      retryStrategy: () => 10_000,
    });
    const reconnectNamespace = `radar:antibot:v1:test-${runId}-reconnect:enforce:`;
    const appReconnect = Fastify({ logger: false });
    await registerAntibot(appReconnect, { config: { ...config, environment: `test-${runId}-reconnect` }, redisClient: reconnecting, observer: () => {} });
    appReconnect.get('/api/vitrine', async () => ({ ok: true }));
    t.after(async () => {
      await appReconnect.close();
      reconnecting.disconnect();
      await cleanNamespace(redisUrl, reconnectNamespace);
    });
    await reconnecting.connect().catch(() => {});
    assert.equal(reconnecting.status, 'reconnecting');
    const reconnectErrors = reconnecting.listenerCount('error');
    const reconnectStart = performance.now();
    assert.equal((await appReconnect.inject('/api/vitrine')).statusCode, 200);
    assert.ok(performance.now() - reconnectStart < 500, 'status reconnecting deve falhar rápido');
    assert.equal(reconnecting.listenerCount('error'), reconnectErrors);
    assert.equal(reconnecting.listenerCount('ready'), 0);
  });
}
