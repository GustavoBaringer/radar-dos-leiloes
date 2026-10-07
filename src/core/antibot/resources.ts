export interface ResourceLease {
  release(): void;
}

export interface ResourcePool {
  /** Shared process-local cap for expensive reads: four by default, no queue. */
  tryAcquireResource(): ResourceLease | null;
  /** Fetch+Sharp job cap: two by default, held until all work has settled. */
  tryAcquireImageJob(): ResourceLease | null;
}

export interface ResourcePoolOptions {
  maxResources?: number;
  maxImageJobs?: number;
}

const READ_LIMIT = 4;
const IMAGE_LIMIT = 2;

function semaphore(limit: number) {
  let active = 0;
  return () => {
    if (active >= limit) return null;
    active++;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active--;
      },
    } satisfies ResourceLease;
  };
}

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
    throw new Error(`${name} deve ser inteiro entre 1 e ${max}`);
  }
  return selected;
}

export function createResourcePool(options: ResourcePoolOptions = {}): ResourcePool {
  const read = semaphore(limit(options.maxResources, READ_LIMIT, READ_LIMIT, 'maxResources'));
  const image = semaphore(limit(options.maxImageJobs, IMAGE_LIMIT, IMAGE_LIMIT, 'maxImageJobs'));
  return { tryAcquireResource: read, tryAcquireImageJob: image };
}

const shared = createResourcePool();

/** Shared default used by phase-2 server integration. */
export const tryAcquireResource = (): ResourceLease | null => shared.tryAcquireResource();
export const tryAcquireImageJob = (): ResourceLease | null => shared.tryAcquireImageJob();
