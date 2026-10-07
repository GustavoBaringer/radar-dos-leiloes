import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWsProtection, type WsRedisClient, type WsSocket } from '../src/core/antibot/ws.js';

class FakeRedis extends EventEmitter implements WsRedisClient {
  status = 'ready';
  count = 0;
  fail = false;
  hold?: (v: number) => void;
  async eval(script: string, _n: number, ...args: (string | number)[]) {
    if (this.fail) throw new Error('offline');
    if (script.startsWith("redis.call('ZREM'")) { this.count = Math.max(0, this.count - 1); return 1; }
    if (script.includes('ZREMRANGEBYSCORE')) {
      if (this.hold) return new Promise<number>((resolve) => { this.hold = resolve; });
      if (this.count >= Number(args[3])) return 0;
      this.count++;
      return 1;
    }
    if (script.includes('ZSCORE')) return 1;
    return 1;
  }
}
class Socket extends EventEmitter implements WsSocket {
  bufferedAmount = 0;
  pings = 0;
  closed: number[] = [];
  terminated = false;
  send() {}
  ping() { this.pings++; }
  close(code = 1000) { this.closed.push(code); }
  terminate() { this.terminated = true; this.emit('close'); }
}
const quietTimers = {
  setTimeout: ((fn: (...args: any[]) => void) => setTimeout(fn, 60_000)) as typeof setTimeout,
  clearTimeout,
  setInterval: ((fn: (...args: any[]) => void) => setInterval(fn, 60_000)) as typeof setInterval,
  clearInterval,
};

test('invalid account and off mode reserve without Redis', async () => {
  const off = createWsProtection({ mode: 'off', environment: 'test', ...quietTimers });
  assert.deepEqual(await off.reserve(0), { allowed: false, status: 401 });
  const result = await off.reserve(1);
  assert.equal(result.allowed, true);
  if (result.allowed) await result.reservation.release();
  await off.close();
});

test('enforce distributed lease, quota, idempotent release and redis outage', async () => {
  const redis = new FakeRedis();
  const ws = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: redis, ...quietTimers });
  const firstFive = await Promise.all(Array.from({ length: 5 }, () => ws.reserve(22)));
  assert(firstFive.every((r) => r.allowed));
  assert.deepEqual(await ws.reserve(22), { allowed: false, status: 429 });
  for (const result of firstFive) if (result.allowed) await result.reservation.release();
  if (firstFive[0].allowed) await firstFive[0].reservation.release();
  assert.equal(redis.count, 0);
  redis.fail = true;
  assert.deepEqual(await ws.reserve(22), { allowed: false, status: 503 });
  await ws.close();
});

test('shadow observes quota and offline but permits untracked local reservations', async () => {
  const redis = new FakeRedis();
  const events: string[] = [];
  const ws = createWsProtection({ mode: 'shadow', environment: 'test', ownedRedisClient: redis, ...quietTimers, onEvent: (e) => events.push(e) });
  redis.count = 5;
  const outcome = await ws.reserve(5);
  assert.equal(outcome.allowed, true);
  if (outcome.allowed) { assert.equal(outcome.reservation.tracked, false); await outcome.reservation.release(); }
  assert.deepEqual(events, ['quota']);
  redis.fail = true;
  assert.equal((await ws.reserve(6)).allowed, true);
  assert.deepEqual(events, ['quota', 'redis_unavailable']);
  await ws.close();
});

test('hard cap includes pending reservations in every mode', async () => {
  const ws = createWsProtection({ mode: 'off', environment: 'test', ...quietTimers });
  const all = await Promise.all(Array.from({ length: 201 }, (_, i) => ws.reserve(i + 1)));
  assert.equal(all.filter((r) => r.allowed).length, 200);
  assert.deepEqual(all[200], { allowed: false, status: 503 });
  await ws.close();
});

test('reservation release during pending claim cleans lease when claim resolves', async () => {
  const redis = new FakeRedis();
  let resolve!: (n: number) => void;
  let firstCall = true;
  redis.eval = async (script) => {
    if (firstCall) { firstCall = false; return new Promise<number>((r) => { resolve = r; }); }
    return script.startsWith("redis.call('ZREM'") ? 1 : 1;
  };
  const ws = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: redis, ...quietTimers });
  const pending = ws.reserve(8);
  await new Promise((resolveReady) => setImmediate(resolveReady));
  await ws.close();
  assert.equal(typeof resolve, 'function');
  resolve(1);
  assert.deepEqual(await pending, { allowed: false, status: 503 });
});

test('ping/send errors and explicit release terminate attached transport and free capacity', async () => {
  const ws = createWsProtection({ mode: 'off', environment: 'test', ...quietTimers });
  const first = await ws.reserve(77);
  assert.equal(first.allowed, true);
  if (first.allowed) {
    const socket = new Socket();
    ws.attach(first.reservation, socket);
    await first.reservation.release();
    assert.equal(socket.terminated, true);
  }
  const second = await ws.reserve(78);
  assert.equal(second.allowed, true);
  if (second.allowed) {
    const socket = new Socket();
    ws.attach(second.reservation, socket);
    socket.send = () => { throw new Error('fixture'); };
    assert.equal(ws.safeSend(socket, 'x'), false);
    assert.equal(socket.terminated, true);
  }
  const third = await ws.reserve(79);
  assert.equal(third.allowed, true);
  if (third.allowed) await third.reservation.release();
  await ws.close();
});

test('ping exception terminates peer instead of releasing only the local slot', async () => {
  const callbacks: (() => void)[] = [];
  const ws = createWsProtection({ mode: 'off', environment: 'test', ...quietTimers, setTimeout,
    setInterval: (((fn: () => void) => { callbacks.push(fn); return { unref() {} } as any; }) as typeof setInterval) });
  const result = await ws.reserve(80);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    const socket = new Socket();
    socket.ping = () => { throw new Error('fixture'); };
    ws.attach(result.reservation, socket);
    callbacks[0]();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(socket.terminated, true);
  }
  await ws.close();
});

test('heartbeat loss, pong handling and backpressure close transport', async () => {
  const redis = new FakeRedis();
  const scheduled: (() => void)[] = [];
  const ws = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: redis,
    setTimeout: quietTimers.setTimeout, clearTimeout, setInterval: (((fn: () => void) => { scheduled.push(fn); return { unref() {} } as any; }) as typeof setInterval), clearInterval });
  const reserved = await ws.reserve(9);
  assert.equal(reserved.allowed, true);
  if (reserved.allowed) {
    const socket = new Socket();
    ws.attach(reserved.reservation, socket);
    scheduled[0]();
    assert.equal(socket.pings, 1);
    socket.emit('pong');
    scheduled[0]();
    socket.bufferedAmount = 1024 * 1024 + 1;
    scheduled[0]();
    assert(socket.closed.includes(1013));
    assert.equal(socket.terminated, true);
  }
  await ws.close();
});

test('enforce closes and terminates promptly when heartbeat lease is lost', async () => {
  const redis = new FakeRedis();
  const scheduled: (() => void)[] = [];
  const originalEval = redis.eval.bind(redis);
  redis.eval = async (script, n, ...args) => script.includes('ZSCORE') && !script.includes('ZREMRANGEBYSCORE') ? 0 : originalEval(script, n, ...args);
  const ws = createWsProtection({ mode: 'enforce', environment: 'test', ownedRedisClient: redis,
    setTimeout, clearTimeout, setInterval: (((fn: () => void) => { scheduled.push(fn); return { unref() {} } as any; }) as typeof setInterval), clearInterval });
  const result = await ws.reserve(10);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    const socket = new Socket();
    ws.attach(result.reservation, socket);
    scheduled[0]();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert(socket.closed.includes(1013));
    assert.equal(socket.terminated, true);
  }
  await ws.close();
});
