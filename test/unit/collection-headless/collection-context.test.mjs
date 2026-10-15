import { describe, expect, it } from '@jest/globals';
import { createCollectionContext } from '../../../dist/src/bootstrap/collection-context.js';
import { CollectionService } from '../../../dist/src/application/services/collection/collection.service.js';
import { CollectionCancellationError, throwIfAborted } from '../../../dist/src/infra/collection/collection-cancellation.js';

function fixture() {
  const order = [];
  const finished = [];
  let runId = 0;
  let closed = 0;
  const deps = {
    lookupConnector: () => ({ collect: async () => { order.push('collect'); return { lots: [], fetched: 0, skipped: 0 }; } }),
    startRun: async (_source, job) => { order.push(job); return ++runId; },
    finishRun: async (id, result) => { finished.push({ id, ...result }); order.push('finish'); },
    observerForCollection: () => undefined,
    upsertLots: async (_lots, control) => {
      throwIfAborted(control?.signal);
      await control?.authorizePersistence?.();
      order.push('upsert');
      await control?.authorizePersistence?.();
      throwIfAborted(control?.signal);
      return { upserted: 1, novos: [1], bidChanges: [] };
    },
    processarAposColeta: async (_ids, publish) => {
      order.push('post');
      await publish?.({ type: 'alerts' });
      return { disparos: 1, push: 1, emails: 1, pendentesEmail: 0 };
    },
    onModuleDestroy: () => { closed++; },
  };
  return { deps, order, finished, get closed() { return closed; } };
}

describe('shared headless Nest collection context', () => {
  it('resolves the real service with injected I/O, no HTTP/OIDC/Redis requirement, and closes once', async () => {
    const state = fixture();
    const context = await createCollectionContext({ dependencies: state.deps });
    try {
      expect(context.app.get(CollectionService)).toBe(context.service);
      expect(context.app.listen).toBeUndefined();
      expect(context.app.getHttpServer).toBeUndefined();
      const result = await context.service.execute({ sourceId: 'fake', limit: 1, job: 'cli', publish: async () => { state.order.push('publish'); } });
      expect(result.upserted).toBe(1);
      expect(state.order).toEqual(['cli', 'collect', 'upsert', 'post', 'finish', 'publish']);
      expect(state.finished[0].ok).toBe(true);
    } finally { await Promise.all([context.close(), context.close()]); }
    expect(state.closed).toBe(1);
    await expect(context.service.execute({ sourceId: 'fake', limit: 1 })).rejects.toThrow('closing');
  });

  it('isolates concurrent per-call effects and a failed execution does not poison the next job', async () => {
    const state = fixture();
    const context = await createCollectionContext({ dependencies: state.deps });
    const events = [];
    try {
      const failure = new CollectionCancellationError('lock_lost');
      await expect(context.service.execute({ sourceId: 'fake', limit: 1, authorizePersistence: () => { throw failure; } })).rejects.toBe(failure);
      expect(state.finished[0].ok).toBe(false);
      expect(state.finished[0].upserted).toBe(0);
      expect(state.order).not.toContain('post');
      await Promise.all(['a', 'b'].map(actor => context.service.execute({ sourceId: actor, job: actor, limit: 1,
        publish: async () => { events.push(`collect-${actor}`); },
      }, { publishNotification: async () => { events.push(`alerts-${actor}`); } })));
      expect(events.sort()).toEqual(['alerts-a', 'alerts-b', 'collect-a', 'collect-b']);
      await context.service.execute({ sourceId: 'audit', limit: 1 }, {
        publishNotification: undefined,
        processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
      });
      expect(events).toHaveLength(4);
      expect(state.finished.map(run => run.ok)).toEqual([false, true, true, true]);
    } finally { await context.close(); }
  });

  it('waits for cancellation/rollback bookkeeping before destroying injected dependencies', async () => {
    const state = fixture();
    const controller = new AbortController();
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    state.deps.upsertLots = async (_lots, control) => {
      expect(control.signal).toBe(controller.signal);
      entered();
      await gate;
      throwIfAborted(control.signal);
      throw new Error('expected cancellation');
    };
    const context = await createCollectionContext({ dependencies: state.deps });
    const running = context.service.execute({ sourceId: 'fake', limit: 1, signal: controller.signal });
    const failed = expect(running).rejects.toBeInstanceOf(CollectionCancellationError);
    await started;
    const closing = context.close();
    controller.abort(new CollectionCancellationError('shutdown'));
    await Promise.resolve();
    expect(state.closed).toBe(0);
    release();
    await failed;
    await closing;
    expect(state.finished[0].ok).toBe(false);
    expect(state.order).not.toContain('post');
    expect(state.closed).toBe(1);
  });
});
