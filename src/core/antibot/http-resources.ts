import type { Decision } from './types.js';
import type { ResourceLease } from './resources.js';

export interface HttpReply {
  code(status: number): this;
  header(name: string, value: string): this;
  send(payload?: unknown): unknown;
  sent?: boolean;
}

export interface HttpResourceGuardOptions {
  tryAcquireResource(): ResourceLease | null;
  acquireDegradedWork(): ResourceLease | null;
}

export interface HttpResourceGuard {
  run<T>(reply: HttpReply, work: () => T | Promise<T>): Promise<T | undefined>;
}

export function sendRateLimit(reply: HttpReply, decision: Decision): boolean {
  if (decision.allowed) return false;
  const retryAfterSeconds = Math.max(1, decision.retryAfterSeconds);
  reply.code(429)
    .header('Retry-After', String(retryAfterSeconds))
    .header('Cache-Control', 'no-store')
    .send({ error: 'rate_limited', retryAfterSeconds });
  return true;
}

export function sendUnauthenticated(reply: HttpReply): void {
  reply.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized' });
}

export function createHttpResourceGuard(options: HttpResourceGuardOptions): HttpResourceGuard {
  return {
    async run<T>(reply: HttpReply, work: () => T | Promise<T>): Promise<T | undefined> {
      const resource = options.tryAcquireResource();
      if (!resource) {
        reply.code(503).header('Retry-After', '1').header('Cache-Control', 'no-store')
          .send({ error: 'overloaded', retryAfterSeconds: 1 });
        return undefined;
      }
      let degraded: ResourceLease | null = null;
      try {
        degraded = options.acquireDegradedWork();
        if (!degraded) {
          reply.code(503).header('Retry-After', '1').header('Cache-Control', 'no-store')
            .send({ error: 'overloaded', retryAfterSeconds: 1 });
          return undefined;
        }
        // Do not release on reply close/client abort: child SQL/native work may still run.
        return await work();
      } finally {
        degraded?.release();
        resource.release();
      }
    },
  };
}
