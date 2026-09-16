import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

// BullMQ exige maxRetriesPerRequest null na conexão de worker/blocking.
export function makeRedis() {
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

export const QUEUE_COLLECT = 'collect';
export const QUEUE_REFRESH = 'refresh';
export const QUEUE_DISCOVER = 'discover';
export const CHANNEL_UPDATES = 'lot-updates';

export interface CollectJob {
  sourceId: string;
  limit: number;
}
export interface RefreshJob {
  reason: string;
}

export interface DiscoverJob {
  qual: 'fenaju' | 'sonda';
  limite?: number;
}

export const collectQueue = new Queue<CollectJob>(QUEUE_COLLECT, { connection: makeRedis() });
export const refreshQueue = new Queue<RefreshJob>(QUEUE_REFRESH, { connection: makeRedis() });
export const discoverQueue = new Queue<DiscoverJob>(QUEUE_DISCOVER, { connection: makeRedis() });

export function makeEvents(name: string) {
  return new QueueEvents(name, { connection: makeRedis() });
}
