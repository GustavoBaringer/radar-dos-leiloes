import { Redis } from 'ioredis';
import type { Job, Worker } from 'bullmq';
import { CollectionCancellationError } from '../collection/collection-cancellation.js';

/** One checker/active-controller registry per worker, never shared across queues. */
export class JobOwnership {
  private readonly client: Redis;
  private readonly controllers = new Map<string, AbortController>();

  constructor(url: string) {
    this.client = new Redis(url, {
      lazyConnect: true, enableReadyCheck: false, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 500, commandTimeout: 500, autoResendUnfulfilledCommands: false,
      retryStrategy: () => null,
    });
    this.client.on('error', () => this.cancel());
    this.client.on('close', () => this.cancel());
  }

  async start(): Promise<void> { await this.client.connect(); }

  track(id: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller;
  }

  release(id: string, controller: AbortController): void {
    if (this.controllers.get(id) === controller) this.controllers.delete(id);
  }

  cancel(ids?: string[], kind: 'shutdown' | 'lock_lost' = 'lock_lost'): void {
    const targets = ids ?? [...this.controllers.keys()];
    for (const id of targets) this.controllers.get(id)?.abort(new CollectionCancellationError(kind));
  }

  monitor(worker: Worker): void {
    worker.on('lockRenewalFailed', ids => this.cancel(ids));
    // Conservative: worker transport/renewal uncertainty cancels only this worker's active jobs.
    worker.on('error', () => this.cancel());
  }

  async authorize(job: Pick<Job, 'id' | 'queueQualifiedName'>, token: string | undefined): Promise<void> {
    try {
      if (!job.id || !job.queueQualifiedName || !token || this.client.status !== 'ready') throw new Error('unavailable');
      // Public queueQualifiedName = prefix:name (QueueKeys); Job.toKey itself is protected.
      if (await this.client.get(`${job.queueQualifiedName}:${job.id}:lock`) !== token) throw new Error('not owned');
    } catch {
      throw new CollectionCancellationError('lock_lost', 'collection job ownership unavailable');
    }
  }

  /** Disconnect is bounded even when Redis is unavailable; called after jobs/bookkeeping drain. */
  close(): void { this.cancel(); this.client.disconnect(); }
}
