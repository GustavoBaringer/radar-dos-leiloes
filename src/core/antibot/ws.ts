import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';

export type WsMode = 'off' | 'shadow' | 'enforce';
export type WsStatus = 401 | 429 | 503;

export interface WsReservation {
  readonly accountId: number;
  readonly tracked: boolean;
  release(): Promise<void>;
}

export type WsReserveResult =
  | { allowed: true; reservation: WsReservation }
  | { allowed: false; status: WsStatus };

export interface WsSocket {
  readyState?: number;
  bufferedAmount: number;
  send(data: string): unknown;
  ping?(): unknown;
  close(code?: number, reason?: string): unknown;
  terminate?(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface WsRedisClient {
  status?: string;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  disconnect?(reconnect?: boolean): unknown;
}

export interface WsProtectionOptions {
  mode: WsMode;
  environment: string;
  redisUrl?: string;
  /** Injected clients remain caller-owned. */
  ownedRedisClient?: WsRedisClient;
  /** Test-only namespace override: must be an exact UUID and requires NODE_ENV=test. */
  prefix?: string;
  /** Test-only lease timing override. */
  testLeaseMs?: number;
  clock?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onEvent?: (event: 'quota' | 'redis_unavailable' | 'lease_lost' | 'capacity', outcome: 'would_deny' | 'denied' | 'allowed') => void;
}

const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
const HARD_CAP = 200;
const UNATTACHED_MS = 30_000;
const MAX_BUFFERED = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 250;

// Lease scripts intentionally do not implement rate limiting; this is only a
// distributed concurrency lease. Redis TIME is authoritative across hosts.
const CLAIM = `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local exp=now+tonumber(ARGV[1]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now); if redis.call('ZSCORE',KEYS[1],ARGV[2]) then redis.call('ZADD',KEYS[1],exp,ARGV[2]); redis.call('PEXPIRE',KEYS[1],ARGV[1]+10000); return 1 end; if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) then return 0 end; redis.call('ZADD',KEYS[1],exp,ARGV[2]); redis.call('PEXPIRE',KEYS[1],ARGV[1]+10000); return 1`;
const RENEW = `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local score=redis.call('ZSCORE',KEYS[1],ARGV[1]); if not score or tonumber(score)<=now then redis.call('ZREM',KEYS[1],ARGV[1]); return 0 end; local exp=now+tonumber(ARGV[2]); redis.call('ZADD',KEYS[1],exp,ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2]+10000); return 1`;
const RELEASE = `redis.call('ZREM',KEYS[1],ARGV[1]); if redis.call('ZCARD',KEYS[1])==0 then redis.call('DEL',KEYS[1]) end; return 1`;

export function createWsProtection(options: WsProtectionOptions) {
  const mode = options.mode;
  if (options.testLeaseMs !== undefined && process.env.NODE_ENV !== 'test') throw new Error('test lease override is restricted to NODE_ENV=test');
  const leaseMs = options.testLeaseMs ?? LEASE_MS;
  const clock = options.clock ?? Date.now;
  const st = options.setTimeout ?? setTimeout;
  const ct = options.clearTimeout ?? clearTimeout;
  const si = options.setInterval ?? setInterval;
  const ci = options.clearInterval ?? clearInterval;
  const observerWindows = new Map<string, { start: number; emitted: number }>();
  const safeEvent = (event: Parameters<NonNullable<WsProtectionOptions['onEvent']>>[0], outcome: 'would_deny' | 'denied' | 'allowed') => {
    if (!options.onEvent) return;
    const now = clock();
    const key = `${event}:${outcome}`;
    let window = observerWindows.get(key);
    if (!window || now - window.start >= 60_000) {
      if (!window && observerWindows.size >= 12) return;
      window = { start: now, emitted: 0 };
      observerWindows.set(key, window);
    }
    if (window.emitted >= 10) return;
    window.emitted++;
    try { options.onEvent(event, outcome); } catch { /* observer is non-critical */ }
  };
  const testPrefix = options.prefix;
  if (testPrefix && (process.env.NODE_ENV !== 'test' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(testPrefix))) {
    throw new Error('WS prefix override is restricted to test UUIDs');
  }
  const namespace = testPrefix ?? 'shared';
  const env = options.environment.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'unknown';
  const namespaceRoot = `antibot:ws:${env}:${mode}:${namespace}`;
  const owned = mode !== 'off' && !options.ownedRedisClient && !!options.redisUrl;
  const redis: WsRedisClient | undefined = mode === 'off' ? undefined : options.ownedRedisClient ?? (options.redisUrl
    ? new Redis(options.redisUrl, {
        lazyConnect: false, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
        connectTimeout: 500, commandTimeout: COMMAND_TIMEOUT_MS, maxRetriesPerRequest: 1,
        retryStrategy: (attempt) => Math.min(1_000 * Math.max(1, attempt), 10_000), enableReadyCheck: true,
      }) as unknown as WsRedisClient
    : undefined);
  // Permanent bounded error listener: never log URLs or account identifiers.
  redis?.on('error', () => { safeEvent('redis_unavailable', mode === 'shadow' ? 'would_deny' : 'denied'); });
  let closed = false;
  let active = 0;
  const reservations = new Set<ReservationImpl>();
  const socketOwners = new WeakMap<WsSocket, ReservationImpl>();

  class ReservationImpl implements WsReservation {
    readonly accountId: number;
    tracked: boolean;
    done = false;
    attached = false;
    leaseKey?: string;
    token?: string;
    unattachedTimer?: ReturnType<typeof setTimeout>;
    socket?: WsSocket;
    heartbeat?: ReturnType<typeof setInterval>;
    terminateTimer?: ReturnType<typeof setTimeout>;
    waitingPong = false;
    renewing = false;
    constructor(accountId: number, tracked: boolean) { this.accountId = accountId; this.tracked = tracked; }
    async release() {
      if (this.done) return;
      this.done = true;
      if (this.unattachedTimer) ct(this.unattachedTimer);
      if (this.heartbeat) ci(this.heartbeat);
      if (this.terminateTimer) ct(this.terminateTimer);
      if (this.socket && this.socket.readyState !== 3) { try { this.socket.terminate?.(); } catch {} }
      reservations.delete(this);
      active = Math.max(0, active - 1);
      if (this.leaseKey && this.token && redis && redis.status === 'ready') {
        try { await redis.eval(RELEASE, 1, this.leaseKey, this.token); } catch { /* Redis command timeout; lease expires conservatively */ }
      }
    }
  }

  async function command(key: string, script: string, ...args: (string | number)[]) {
    if (!redis || redis.status !== 'ready') throw new Error('redis unavailable');
    return redis.eval(script, 1, key, ...args);
  }

  async function reserve(accountId: number): Promise<WsReserveResult> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return { allowed: false, status: 401 };
    if (closed) return { allowed: false, status: 503 };
    if (active >= HARD_CAP) {
      safeEvent('capacity', 'denied');
      return { allowed: false, status: 503 };
    }
    // Count pending handshakes before any Redis await.
    const reservation = local(accountId);
    if (mode === 'off') return { allowed: true, reservation };
    if (!redis || redis.status !== 'ready') {
      safeEvent('redis_unavailable', mode === 'shadow' ? 'would_deny' : 'denied');
      if (mode === 'enforce') { await reservation.release(); return { allowed: false, status: 503 }; }
      return { allowed: true, reservation };
    }
    const key = `${namespaceRoot}:account:${accountId}`;
    const token = randomBytes(24).toString('hex');
    try {
      const result = Number(await command(key, CLAIM, leaseMs, token, 5));
      if (reservation.done || closed) {
        if (result === 1) {
          try { await command(key, RELEASE, token); } catch { /* lease TTL bounds late claim cleanup */ }
        }
        return { allowed: false, status: 503 };
      }
      if (result !== 1) {
        safeEvent('quota', mode === 'shadow' ? 'would_deny' : 'denied');
        if (mode === 'enforce') { await reservation.release(); return { allowed: false, status: 429 }; }
        return { allowed: true, reservation };
      }
      reservation.leaseKey = key;
      reservation.token = token;
      reservation.tracked = true;
      return { allowed: true, reservation };
    } catch {
      safeEvent('redis_unavailable', mode === 'shadow' ? 'would_deny' : 'denied');
      if (redis.status === 'ready') {
        try { await command(key, RELEASE, token); } catch { /* uncertain claim expires within its lease TTL */ }
      }
      if (reservation.done || closed) { await reservation.release(); return { allowed: false, status: 503 }; }
      if (mode === 'enforce') { await reservation.release(); return { allowed: false, status: 503 }; }
      return { allowed: true, reservation };
    }
  }

  function local(accountId: number) {
    const r = new ReservationImpl(accountId, false);
    active++;
    reservations.add(r);
    r.unattachedTimer = st(() => { void r.release(); }, UNATTACHED_MS);
    r.unattachedTimer.unref?.();
    return r;
  }

  function attach(reservation: WsReservation, socket: WsSocket) {
    const r = reservation as ReservationImpl;
    if (!(r instanceof ReservationImpl) || r.done || closed || r.attached) { try { socket.terminate?.(); } catch {} return; }
    r.attached = true;
    r.socket = socket;
    socketOwners.set(socket, r);
    if (r.unattachedTimer) ct(r.unattachedTimer);
    const finish = () => { void r.release(); };
    socket.on('close', finish);
    socket.on('error', () => { try { socket.terminate?.(); } catch {} finish(); });
    socket.on('pong', () => { r.waitingPong = false; });
    const fail = () => {
      try { socket.close(1013, 'service unavailable'); } catch {}
      r.terminateTimer = st(() => { try { socket.terminate?.(); } catch {} finish(); }, 100);
      r.terminateTimer.unref?.();
    };
    r.heartbeat = si(() => {
      if (r.done || closed) return;
      if (socket.bufferedAmount > MAX_BUFFERED) { try { socket.close(1013, 'backpressure'); } catch {} try { socket.terminate?.(); } catch {} finish(); return; }
      if (r.waitingPong) { try { socket.close(1013, 'heartbeat timeout'); } catch {} try { socket.terminate?.(); } catch {} finish(); return; }
      r.waitingPong = true;
      try { socket.ping?.(); } catch { fail(); return; }
      if (!r.leaseKey || !r.token || !redis) return;
      if (r.renewing) { if (mode === 'enforce') fail(); return; }
      r.renewing = true;
      void command(r.leaseKey, RENEW, r.token, leaseMs).then((value) => {
        if (Number(value) !== 1) {
          safeEvent('lease_lost', mode === 'shadow' ? 'would_deny' : 'denied');
          if (mode === 'enforce') fail();
          else { r.leaseKey = undefined; r.token = undefined; r.tracked = false; }
        }
      }).catch(() => {
        safeEvent('redis_unavailable', mode === 'shadow' ? 'would_deny' : 'denied');
        if (mode === 'enforce') fail();
        else { r.leaseKey = undefined; r.token = undefined; r.tracked = false; }
      }).finally(() => { r.renewing = false; });
    }, RENEW_MS);
    r.heartbeat.unref?.();
  }

  function safeSend(socket: WsSocket, data: string): boolean {
    if (closed || socket.bufferedAmount > MAX_BUFFERED) {
      try { socket.close(1013, 'backpressure'); } catch {}
      try { socket.terminate?.(); } catch {}
      const owner = socketOwners.get(socket);
      if (owner) void owner.release();
      return false;
    }
    try { socket.send(data); return true; } catch {
      try { socket.terminate?.(); } catch {}
      const owner = socketOwners.get(socket);
      if (owner) void owner.release();
      return false;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all([...reservations].map(async (r) => {
      if (r.socket) { try { r.socket.terminate?.(); } catch {} }
      await r.release();
    }));
    if (owned) { try { redis?.disconnect?.(); } catch {} }
  }

  return { reserve, attach, safeSend, close, release: (r: WsReservation) => r.release() };
}
