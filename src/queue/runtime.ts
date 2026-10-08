import { Queue, QueueEvents } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
export const QUEUE_COLLECT = 'collect';
export const QUEUE_REFRESH = 'refresh';
export const QUEUE_DISCOVER = 'discover';
export const CHANNEL_UPDATES = 'lot-updates';

export interface CollectJob { sourceId: string; limit: number }
export interface RefreshJob { reason: string }
export interface DiscoverJob { qual: 'fenaju' | 'sonda'; limite?: number }

export function makeRedis(url = REDIS_URL, options: RedisOptions = {}) {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true, ...options });
}

export function makeAntibotRedis(url: string) {
  return makeRedis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    commandTimeout: 250,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (attempt) => Math.min(attempt * 1_000, 10_000),
  });
}

export function makeWsRedis(url: string) {
  return makeRedis(url, {
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 500,
    commandTimeout: 250,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(1_000 * Math.max(1, attempt), 10_000),
    enableReadyCheck: true,
  });
}

export function createCollectQueue(connection: Redis = makeRedis()) {
  return new Queue<CollectJob>(QUEUE_COLLECT, { connection });
}

export function makeEvents(name: string) {
  return new QueueEvents(name, { connection: makeRedis() });
}
