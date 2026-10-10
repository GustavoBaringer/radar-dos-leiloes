import { CollectionCancellationError, throwIfAborted } from '../core/collection-cancellation.js';

/** One failing upstream must not prevent refreshing the other sources. */
export async function refreshBatch<T>(
  sources: readonly (readonly [string, number])[],
  collect: (source: string, limit: number) => Promise<T>,
  onFailure: (source: string, error: unknown) => void,
  signal?: AbortSignal,
) {
  const completed: string[] = [], failed: string[] = [];
  for (const [source, limit] of sources) {
    throwIfAborted(signal);
    try {
      await collect(source, limit);
      completed.push(source);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof CollectionCancellationError && error.kind !== 'deadline') throw error;
      failed.push(source);
      onFailure(source, error);
    }
  }
  return { hot: sources.length, completed, failed };
}
