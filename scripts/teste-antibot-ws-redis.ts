import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { createWsProtection, type WsRedisClient, type WsSocket } from '../src/core/antibot/ws.js';

process.env.NODE_ENV = 'test';
const url = process.env.ANTIBOT_TEST_REDIS_URL;
const enabled = !!url;
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('ANTIBOT_TEST_REDIS_URL must use loopback');
  }
}

async function waitReady(client: Redis, timeoutMs = 3_000): Promise<void> {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Redis readiness timeout')), timeoutMs);
    const ready = () => done();
    const error = (err: Error) => done(err);
    const end = () => done(new Error('Redis connection ended before ready'));
    function done(err?: Error) {
      clearTimeout(timer);
      client.off('ready', ready);
      client.off('error', error);
      client.off('end', end);
      if (err) reject(err); else resolve();
    }
    client.on('ready', ready);
    client.on('error', error);
    client.on('end', end);
  });
}

class Socket extends EventEmitter implements WsSocket {
  readyState = 1;
  bufferedAmount = 0;
  terminated = false;
  send() {}
  ping() {}
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
}

test('Redis real: dois clientes, cap distribuído, renew, expiração sem ressurreição e cleanup UUID', { skip: !enabled }, async () => {
  const uuid = randomUUID();
  const redisUrl = url!;
  const c1 = new Redis(redisUrl, { enableOfflineQueue: false, connectTimeout: 500, commandTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null });
  const c2 = new Redis(redisUrl, { enableOfflineQueue: false, connectTimeout: 500, commandTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null });
  const pattern = `antibot:ws:test:enforce:${uuid}:*`;
  const a = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: c1 as unknown as WsRedisClient, prefix: uuid, testLeaseMs: 10_000 });
  const b = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: c2 as unknown as WsRedisClient, prefix: uuid, testLeaseMs: 10_000 });
  let ready = false;
  try {
    await Promise.all([waitReady(c1), waitReady(c2)]);
    ready = true;
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).reserve(991337)));
    assert.equal(claims.filter((r) => r.allowed).length, 5);
    assert.equal(claims.filter((r) => !r.allowed && r.status === 429).length, 5);
    for (const result of claims) if (result.allowed) await result.reservation.release();

    const ticks: (() => void)[] = [];
    const short = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: c1 as unknown as WsRedisClient,
      prefix: uuid, testLeaseMs: 250,
      setInterval: (((fn: () => void) => { ticks.push(fn); return { unref() {} } as any; }) as typeof setInterval) });
    const renewing = await short.reserve(991338);
    assert.equal(renewing.allowed, true);
    assert.equal(renewing.allowed && renewing.reservation.tracked, true);
    const key = `antibot:ws:test:enforce:${uuid}:account:991338`;
    const initialMembers = await c1.zrange(key, 0, -1, 'WITHSCORES');
    assert.equal(initialMembers.length, 2);
    const renewToken = initialMembers[0];
    const initial = Number(initialMembers[1]);
    if (renewing.allowed) {
      const socket = new Socket();
      short.attach(renewing.reservation, socket);
      ticks[0]();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const renewed = Number(await c1.zscore(key, renewToken));
      assert(renewed > initial, 'live renewal extends score');
      await new Promise((resolve) => setTimeout(resolve, 280));
      assert.equal(Number(await c1.zcard(key)), 1, 'renewed lease remains present beyond original expiry');
      await renewing.reservation.release();
      assert.equal(socket.terminated, true);
    }

    const expired = await short.reserve(991339);
    assert.equal(expired.allowed, true);
    const expiredKey = `antibot:ws:test:enforce:${uuid}:account:991339`;
    const expiredMembers = await c1.zrange(expiredKey, 0, -1, 'WITHSCORES');
    assert.equal(expiredMembers.length, 2);
    const oldSocket = new Socket();
    if (expired.allowed) short.attach(expired.reservation, oldSocket);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const replacement = await b.reserve(991339);
    assert.equal(replacement.allowed, true, 'expired member does not block a new claim');
    ticks[1]();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(Number(await c1.zcard(expiredKey)), 1, 'renewal of expired old token cannot resurrect it');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(oldSocket.terminated, true, 'enforce terminates a socket after lease loss');
    if (replacement.allowed) await replacement.reservation.release();
    if (expired.allowed) await expired.reservation.release();
    await short.close();
  } finally {
    await Promise.all([a.close(), b.close()]);
    if (ready) {
      let cursor = '0';
      do {
        const [next, keys] = await c1.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length) await c1.del(...keys);
      } while (cursor !== '0');
    }
    await Promise.all([c1.quit().catch(() => c1.disconnect()), c2.quit().catch(() => c2.disconnect())]);
  }
});
