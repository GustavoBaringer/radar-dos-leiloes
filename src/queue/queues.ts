import { Queue } from 'bullmq';
import { makeRedis, QUEUE_COLLECT, QUEUE_DISCOVER, QUEUE_REFRESH, type CollectJob, type DiscoverJob, type RefreshJob } from './runtime.js';
export * from './runtime.js';

// Legacy worker-facing singletons remain; HTTP bootstrap uses runtime.ts only.
export const collectQueue = new Queue<CollectJob>(QUEUE_COLLECT, { connection: makeRedis() });
export const refreshQueue = new Queue<RefreshJob>(QUEUE_REFRESH, { connection: makeRedis() });
export const discoverQueue = new Queue<DiscoverJob>(QUEUE_DISCOVER, { connection: makeRedis() });
