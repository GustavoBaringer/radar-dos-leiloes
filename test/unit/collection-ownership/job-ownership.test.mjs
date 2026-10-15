import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { JobOwnership } from '../../../dist/src/infra/queue/job-ownership.js';
import { CollectionCancellationError } from '../../../dist/src/infra/collection/collection-cancellation.js';

describe('worker-scoped ownership controllers (no Redis connection)', () => {
  it('isolates equal IDs across workers and old finally cannot delete or abort a successor', () => {
    const a = new JobOwnership('redis://127.0.0.1:56380');
    const b = new JobOwnership('redis://127.0.0.1:56380');
    try {
      const old = a.track('same');
      const successor = a.track('same');
      const otherQueue = b.track('same');
      a.release('same', old);
      expect(successor.signal.aborted).toBe(false);
      expect(otherQueue.signal.aborted).toBe(false);
      a.cancel(['same']);
      expect(old.signal.aborted).toBe(false);
      expect(successor.signal.reason).toBeInstanceOf(CollectionCancellationError);
      expect(successor.signal.reason.kind).toBe('lock_lost');
      expect(otherQueue.signal.aborted).toBe(false);
    } finally { a.close(); b.close(); }
  });

  it('binds renewal and transport uncertainty only to its own worker (synthetic unit events)', () => {
    const a = new JobOwnership('redis://127.0.0.1:56380');
    const b = new JobOwnership('redis://127.0.0.1:56380');
    const workerA = new EventEmitter();
    const workerB = new EventEmitter();
    a.monitor(workerA); b.monitor(workerB);
    try {
      const one = a.track('one'); const two = a.track('two'); const other = b.track('one');
      workerA.emit('lockRenewalFailed', ['one']);
      expect(one.signal.aborted).toBe(true);
      expect(two.signal.aborted).toBe(false);
      expect(other.signal.aborted).toBe(false);
      workerA.emit('error', new Error('transport uncertain'));
      expect(two.signal.aborted).toBe(true);
      expect(other.signal.aborted).toBe(false);
    } finally { a.close(); b.close(); }
  });

  it('fails closed before connecting, with no Redis I/O and no token in its error', async () => {
    const checker = new JobOwnership('redis://127.0.0.1:56380');
    try {
      await expect(checker.authorize({ id: '1', queueQualifiedName: 'fixture' }, 'secret-token')).rejects.toMatchObject({
        kind: 'lock_lost', message: 'collection job ownership unavailable',
      });
    } finally { checker.close(); }
  });
});
