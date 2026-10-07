import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { loadAntibotConfig } from './config.js';
import { createAntibot, type Antibot } from './engine.js';
import { normalizeClientIp } from './ip.js';
import { ROUTE_POLICIES } from './routes.js';
import type { AntibotConfig, AntibotObserver, Policy, PolicyId, RateLimitDriver, Subject } from './types.js';

interface RateLimitResult {
  isAllowed: boolean;
  isExceeded?: boolean;
  ttl?: number;
}
type ManualChecker = (request: FastifyRequest) => Promise<RateLimitResult>;

function officialResultAllowed(result: RateLimitResult): boolean {
  return result.isAllowed || !result.isExceeded;
}

export interface AntibotRequest extends FastifyRequest {
  eu?: { userId?: unknown };
}

export interface RegisterAntibotOptions {
  config?: AntibotConfig;
  env?: NodeJS.ProcessEnv;
  observer?: AntibotObserver;
  driver?: RateLimitDriver;
  /**
   * Optional client seam, chiefly for testing real connection states.
   * Ownership stays with the caller: registerAntibot never disconnects an injected client,
   * the caller closes it (see the host's onClose block).
   */
  redisClient?: Redis;
  clock?: () => number;
}

export interface AntibotRegistration extends Antibot {
  readonly preAuthHook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly postAuthHook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/** The only boundary that adapts an opaque key to the official plugin's request API. */
function requestForKey(key: string): FastifyRequest {
  return { antibotKey: key, routeOptions: { config: {} } } as unknown as FastifyRequest;
}

function keyFromRequest(request: FastifyRequest): string {
  return (request as FastifyRequest & { antibotKey: string }).antibotKey;
}

function routePolicy(request: FastifyRequest): PolicyId | undefined {
  const method = String(request.method).toUpperCase();
  const template = request.routeOptions.url;
  if (!template) return undefined;
  return ROUTE_POLICIES[`${method} ${template}`];
}

function sendDenied(reply: FastifyReply, seconds: number) {
  return reply
    .code(429)
    .header('Retry-After', String(Math.max(1, seconds)))
    .header('Cache-Control', 'no-store')
    .send({ error: 'rate_limited', retryAfterSeconds: Math.max(1, seconds) });
}

function createRedis(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    commandTimeout: 250,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (attempt) => Math.min(attempt * 1_000, 10_000),
  });
}

function requireRedisReady(redis: Redis): void {
  if (redis.status !== 'ready') throw new Error('Redis not ready');
}

export async function registerAntibot(
  fastify: FastifyInstance,
  options: RegisterAntibotOptions = {},
): Promise<AntibotRegistration> {
  const config = options.config ?? loadAntibotConfig(options.env ?? process.env);
  let redis: Redis | undefined;
  let driver = options.driver;
  if (config.mode !== 'off' && !driver) {
    redis = options.redisClient ?? createRedis(config.redisUrl);
    // Cliente injetado tem dono único: quem o cria é quem desconecta. O driver só
    // assume o fechamento do cliente criado aqui dentro.
    const ownsRedis = !options.redisClient;
    // One permanent listener prevents ioredis's unhandled-error logging; request
    // paths never add/remove listeners and the engine emits bounded safe signals.
    redis.on('error', () => {});
    await fastify.register(rateLimit, {
      global: false,
      redis,
      nameSpace: `radar:antibot:v1:${config.environment}:${config.mode}:`,
      skipOnError: false,
      ban: -1,
      continueExceeding: false,
      exponentialBackoff: false,
    });
    const checkers = new Map<PolicyId, ManualChecker>();
    for (const policy of Object.values(config.policies)) {
      const checker = fastify.createRateLimit({
        max: policy.max,
        timeWindow: policy.windowMs,
        keyGenerator: (request) => keyFromRequest(request),
      });
      checkers.set(policy.id, checker);
    }
    driver = {
      async check(policy: Policy, key: string) {
        const checker = checkers.get(policy.id);
        if (!checker) throw new Error('checker não registrado');
        requireRedisReady(redis!);
        const result = await checker(requestForKey(key));
        // v10.3.0 may return isAllowed:false below quota; isExceeded is authoritative.
        const allowed = officialResultAllowed(result);
        return { allowed, ttlMs: Math.max(0, result.ttl ?? 0) };
      },
      async ping() { requireRedisReady(redis!); await redis!.ping(); },
      async close() { if (ownsRedis) redis!.disconnect(); },
    };
  }

  const engine = createAntibot({ config, driver, observer: options.observer, clock: options.clock });
  const preAuthHook: AntibotRegistration['preAuthHook'] = async (request, reply) => {
    if (config.mode === 'off') return;
    const id = routePolicy(request);
    if (!id || config.policies[id].identity !== 'ip') return;
    const subject: Subject = { type: 'ip', value: normalizeClientIp(request.ip) };
    const decision = await engine.check(id, subject);
    if (!decision.allowed) sendDenied(reply, decision.retryAfterSeconds);
  };
  const postAuthHook: AntibotRegistration['postAuthHook'] = async (request, reply) => {
    const id = routePolicy(request);
    if (!id || config.policies[id].identity !== 'account') return;
    const userId = (request as AntibotRequest).eu?.userId;
    // Account policies always require a resolved owner, even when quotas are off.
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
      reply.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized' });
      return;
    }
    if (config.mode === 'off') return;
    const decision = await engine.check(id, { type: 'account', id: userId });
    if (!decision.allowed) sendDenied(reply, decision.retryAfterSeconds);
  };

  // Call before the auth onRequest hook: IP policies run pre-auth; account policies
  // run only after auth has admitted the request.
  fastify.addHook('onRequest', preAuthHook);
  fastify.addHook('preHandler', postAuthHook);
  const registration: AntibotRegistration = { ...engine, preAuthHook, postAuthHook };
  fastify.addHook('onClose', async () => registration.close());
  return registration;
}
