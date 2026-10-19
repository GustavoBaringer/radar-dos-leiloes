import { describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { JobOwnership } from '../../../dist/src/infra/queue/job-ownership.js';
import { createCollectionContext } from '../../../dist/src/bootstrap/collection-context.js';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { LotsRepository } from '../../../dist/src/infra/database/repositories/lots.repository.js';
import { observerForCollection } from '../../../dist/src/application/services/collection/collection-observer.js';
import { startRun } from '../../../dist/src/core/repo.js';

const redisUrl = 'redis://127.0.0.1:56380';
const prefix = `ownership5-${process.pid}-${Date.now()}`;
const connection = { host: '127.0.0.1', port: 56380, maxRetriesPerRequest: null };
function guardFixture() {
  const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
  if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' ||
      db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.pathname !== '/radar_prisma') {
    throw new Error('Refusing ownership test outside isolated radar_prisma fixture');
  }
  if (new URL(redisUrl).hostname !== '127.0.0.1' || new URL(redisUrl).port !== '56380') throw new Error('Unsafe Redis fixture');
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); reject(new Error('Real lock renewal event did not abort in time')); }, 3_000);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

describe('real BullMQ ownership and atomic PostgreSQL persistence', () => {
  it('reconnects its checker after connection loss and authorizes the next persisted job', async () => {
    guardFixture();
    const name = `${prefix}-recovery`;
    const sourceId = `${prefix}-recovery`;
    const checker = new JobOwnership(redisUrl);
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
    admin.on('error', () => {});
    const queue = new Queue(name, { connection, prefix });
    queue.on('error', () => {});
    let worker;
    let context;
    let prisma;
    let sourceCreated = false;
    let oldController;
    let oldJob;
    let oldToken;
    let oldAborted = deferred();
    let oldRelease = deferred();
    let finished = deferred();
    let outcome;
    const lot = externalId => ({ sourceId, externalId, titleRaw: 'Honda Civic 2020',
      closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: 'aberto', currentBid: 100, photos: [] });
    try {
      await checker.start();
      context = await createCollectionContext({ overrides: {
        lookupConnector: () => ({ collect: async () => ({ lots: [lot('one'), lot('two')], fetched: 2, skipped: 0, httpStatus: 200 }) }),
        processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
      } });
      prisma = context.app.get(PrismaService);
      await prisma.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${sourceId}, ${'ownership recovery fixture'}, ${'html'})`;
      sourceCreated = true;
      worker = new Worker(name, async (job, token) => {
        const controller = checker.track(job.id);
        try {
          if (job.name === 'old') {
            oldController = controller;
            oldJob = job;
            oldToken = token;
            oldAborted.resolve();
            await oldRelease.promise;
            throw controller.signal.reason;
          }
          const result = await context.service.execute({ sourceId, tenant: 'fixture.example.test', guaranteeTenantAttempt: true,
            limit: 2, signal: controller.signal, authorizePersistence: () => checker.authorize(job, token), publish: async () => {} }, {
            upsertLots: new LotsRepository(prisma).upsertLots.bind(new LotsRepository(prisma)),
            startRun,
            observerForCollection: ctx => observerForCollection(ctx, true),
          });
          outcome = result;
          return result.upserted;
        } finally { checker.release(job.id, controller); }
      }, { connection, prefix, concurrency: 1, lockDuration: 20_000, stalledInterval: 20_000 });
      checker.monitor(worker);
      worker.on('error', () => {});
      worker.on('completed', job => { if (job.name === 'new') finished.resolve(); });
      worker.on('failed', job => { if (job.name === 'new') finished.resolve(); });
      await worker.waitUntilReady();
      await queue.add('old', {}, { jobId: 'old', attempts: 1 });
      await oldAborted.promise;
      const checkerId = await checker.client.call('CLIENT', 'ID');
      // The checker owns a separate connection; kill only that exact client.
      if (!checkerId) throw new Error('Could not identify private checker Redis connection');
      expect(await admin.call('CLIENT', 'KILL', 'ID', checkerId)).toBe(1);
      await waitForAbort(oldController.signal);
      expect(oldController.signal.reason.kind).toBe('lock_lost');
      expect(checker.client.status).not.toBe('ready');
      await expect(checker.authorize(oldJob, oldToken)).rejects.toMatchObject({ kind: 'lock_lost' });
      oldRelease.resolve();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && checker.client.status !== 'ready') await new Promise(resolve => setTimeout(resolve, 25));
      expect(checker.client.status).toBe('ready');
      await queue.add('new', {}, { jobId: 'new', attempts: 1 });
      await finished.promise;
      expect(outcome.upserted).toBe(2);
      expect(await prisma.lots.count({ where: { source_id: sourceId } })).toBe(2);
      expect(await prisma.lots.count({ where: { source_id: sourceId, external_id: { in: ['one', 'two'] } } })).toBe(2);
    } finally {
      oldRelease.resolve();
      await worker?.close();
      try {
        await queue.obliterate({ force: true });
        await queue.close();
        if (prisma && sourceCreated) {
          await prisma.$executeRaw`DELETE FROM tenant_collection_attempts WHERE source_id=${sourceId}`;
          await prisma.$executeRaw`DELETE FROM collection_runs WHERE source_id=${sourceId}`;
          await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
          await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
        }
      } finally { await context?.close(); checker.close(); admin.disconnect(); }
    }
  }, 60_000);

  for (const mode of ['missing', 'replaced', 'renewal', 'success']) {
    it(`${mode}: actual processor token/key guards the shared service and transaction`, async () => {
      guardFixture();
      const name = `${prefix}-${mode}`;
      const sourceId = `${prefix}-${mode}`;
      const checker = new JobOwnership(redisUrl);
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 500, commandTimeout: 500 });
      redis.on('error', () => {});
      const queue = new Queue(name, { connection, prefix });
      queue.on('error', () => {});
      const done = deferred();
      let worker;
      let context;
      let prisma;
      let sourceCreated = false;
      let queries = 0;
      let authorizations = 0;
      let observedWrites = 0;
      let renewals = 0;
      let runId;
      let outcome;
      let signal;
      const effects = [];
      const errors = [];
      const lot = (externalId, overrides = {}) => ({ sourceId, externalId, titleRaw: 'Honda Civic 2020',
        closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: 'aberto', currentBid: 100, photos: [], ...overrides });
      const batch = [lot('existing', { currentBid: 200 }), lot('new'), lot('close', { titleRaw: 'Quadro decorativo', assetType: 'outro' })];
      const snapshot = async () => ({
        lots: await prisma.lots.findMany({ where: { source_id: sourceId }, orderBy: { external_id: 'asc' } }),
        history: await prisma.bid_history.findMany({ where: { lots: { source_id: sourceId } }, orderBy: { id: 'asc' } }),
      });
      try {
        await checker.start();
        context = await createCollectionContext({ overrides: {
          lookupConnector: () => ({ collect: async () => ({ lots: batch, fetched: 3, skipped: 0, httpStatus: 200 }) }),
          processarAposColeta: async () => { effects.push('post'); return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; },
        } });
        prisma = context.app.get(PrismaService);
        await prisma.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${sourceId}, ${'ownership fixture'}, ${'html'})`;
        sourceCreated = true;
        await new LotsRepository(prisma).upsertLots([lot('existing'), lot('close')]);
        const baseline = await snapshot();
        // Constructor injection only in the test: every observed query still awaits real PostgreSQL.
        let currentJob;
        let currentToken;
        const observed = new LotsRepository({ $transaction: (callback, options) => prisma.$transaction(async tx => {
          const client = Object.fromEntries(['$queryRawUnsafe', '$executeRawUnsafe'].map(method => [method, async (sql, ...params) => {
            const result = await tx[method](sql, ...params);
            queries++;
            if (/^\s*(INSERT|UPDATE)/.test(sql)) {
              observedWrites++;
              if (observedWrites === 1) {
                const [changed] = await tx.$queryRawUnsafe('SELECT current_bid FROM lots WHERE source_id=$1 AND external_id=$2', sourceId, 'existing');
                expect(Number(changed.current_bid)).toBe(200);
                const key = `${currentJob.toKey(currentJob.id)}:lock`;
                expect(await redis.get(key)).toBe(currentToken);
                if (mode === 'replaced') await redis.set(key, 'different-fixture-owner', 'PX', 10_000);
                if (mode === 'missing' || mode === 'renewal') await redis.del(key);
                if (mode === 'renewal') await waitForAbort(signal);
              }
            }
            return result;
          }]));
          return callback(client);
        }, options) });
        worker = new Worker(name, async (job, token) => {
          const controller = checker.track(job.id);
          signal = controller.signal;
          currentJob = job; currentToken = token;
          try {
            const result = await context.service.execute({ sourceId, tenant: 'fixture.example.test', guaranteeTenantAttempt: true,
              limit: 3, signal, authorizePersistence: async () => { authorizations++; await checker.authorize(job, token); },
              publish: async () => { effects.push('publish'); },
            }, { upsertLots: observed.upsertLots.bind(observed), startRun: async (...args) => {
              runId = await startRun(...args); return runId;
            }, observerForCollection: context => observerForCollection(context, true) });
            outcome = result;
            return result.upserted;
          } catch (error) {
            outcome = error;
            throw error;
          } finally {
            // Restore only this test job's lease so BullMQ can finish its failure bookkeeping.
            await redis.set(`${job.toKey(job.id)}:lock`, token, 'PX', 10_000);
            checker.release(job.id, controller);
          }
        }, { connection, prefix, concurrency: 1, lockDuration: mode === 'renewal' ? 1_000 : 20_000,
          lockRenewTime: mode === 'renewal' ? 100 : 10_000, stalledInterval: 20_000 });
        checker.monitor(worker);
        worker.on('lockRenewalFailed', () => { renewals++; });
        worker.on('error', error => { errors.push(error); });
        worker.on('completed', () => done.resolve());
        worker.on('failed', () => done.resolve());
        await worker.waitUntilReady();
        await queue.add('fixture', {}, { jobId: 'same-id', attempts: 1 });
        await done.promise;
        expect(queries).toBeGreaterThan(0);
        if (mode === 'success') {
          expect(outcome.upserted).toBe(2);
          expect(authorizations).toBe(2);
          expect(observedWrites).toBe(5);
          expect(effects).toEqual(['post', 'publish', 'publish']); // bids then collect
        } else {
          expect(outcome.kind).toBe('lock_lost');
          expect(effects).toEqual([]);
          expect(await snapshot()).toEqual(baseline);
          expect(authorizations).toBe(mode === 'renewal' ? 1 : 2);
          expect(observedWrites).toBe(mode === 'renewal' ? 2 : 5);
          if (mode === 'renewal') expect(renewals).toBeGreaterThan(0);
        }
        const [run] = await prisma.$queryRaw`SELECT ok,upserted,finished_at FROM collection_runs WHERE id=${runId}`;
        expect(run.ok).toBe(mode === 'success');
        expect(Number(run.upserted)).toBe(mode === 'success' ? 2 : 0);
        expect(run.finished_at).not.toBeNull();
        const [attempt] = await prisma.$queryRaw`SELECT state,error_kind,returned FROM tenant_collection_attempts WHERE run_id=${runId}`;
        expect(attempt.state).toBe(mode === 'success' ? 'completed' : 'partial');
        expect(attempt.error_kind).toBe(mode === 'success' ? null : 'network');
        expect(attempt.returned).toBe(3);
      } finally {
        checker.cancel(undefined, 'shutdown');
        await worker?.close();
        try {
          // This name/prefix are generated solely for this fixture; never obliterate an existing queue.
          if (!name.startsWith(prefix)) throw new Error('Unsafe queue cleanup');
          await queue.obliterate({ force: true });
          await queue.close();
          if (prisma && sourceCreated) {
            await prisma.$executeRaw`DELETE FROM tenant_collection_attempts WHERE source_id=${sourceId}`;
            await prisma.$executeRaw`DELETE FROM collection_runs WHERE source_id=${sourceId}`;
            await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
            await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
          }
        } finally {
          await context?.close(); checker.close(); redis.disconnect();
        }
      }
    }, 120_000);
  }

  it('uses different real tokens for equal IDs in two queues; renewal loss in A leaves B running', async () => {
    guardFixture();
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
    redis.on('error', () => {});
    const states = ['a', 'b'].map(label => ({ label, name: `${prefix}-isolation-${label}`,
      checker: new JobOwnership(redisUrl), started: deferred(), release: deferred(), done: deferred() }));
    try {
      for (const state of states) {
        await state.checker.start();
        state.queue = new Queue(state.name, { connection, prefix });
        state.queue.on('error', () => {});
        state.worker = new Worker(state.name, async (job, token) => {
          const controller = state.checker.track(job.id);
          state.signal = controller.signal;
          state.key = `${job.toKey(job.id)}:lock`;
          state.token = token;
          try {
            await state.checker.authorize(job, token);
            state.started.resolve();
            await state.release.promise;
            await state.checker.authorize(job, token);
          } catch (error) { state.failure = error; throw error; }
          finally {
            await redis.set(state.key, token, 'PX', 10_000);
            state.checker.release(job.id, controller);
          }
        }, { connection, prefix, lockDuration: 1_000, lockRenewTime: 100, stalledInterval: 20_000 });
        state.checker.monitor(state.worker);
        state.worker.on('error', () => {});
        state.worker.on('completed', () => state.done.resolve());
        state.worker.on('failed', () => state.done.resolve());
        await state.worker.waitUntilReady();
        await state.queue.add('fixture', {}, { jobId: 'same-id', attempts: 1 });
      }
      await Promise.all(states.map(state => state.started.promise));
      const [a, b] = states;
      expect(a.key).not.toBe(b.key);
      expect(a.token).not.toBe(b.token);
      expect(await redis.get(a.key)).toBe(a.token);
      expect(await redis.get(b.key)).toBe(b.token);
      await redis.del(a.key);
      await waitForAbort(a.signal);
      expect(a.signal.reason.kind).toBe('lock_lost');
      expect(b.signal.aborted).toBe(false);
      states.forEach(state => state.release.resolve());
      await Promise.all(states.map(state => state.done.promise));
      expect(a.failure.kind).toBe('lock_lost');
      expect(b.failure).toBeUndefined();
      expect(b.signal.aborted).toBe(false);
    } finally {
      states.forEach(state => state.release.resolve());
      await Promise.all(states.map(async state => {
        await state.worker?.close();
        try {
          if (!state.name.startsWith(prefix)) throw new Error('Unsafe queue cleanup');
          await state.queue?.obliterate({ force: true });
          await state.queue?.close();
        } finally { state.checker.close(); }
      }));
      redis.disconnect();
    }
  }, 60_000);

  it('fails closed within 2 seconds on checker connection refusal and after disconnect', async () => {
    guardFixture();
    const unavailable = new JobOwnership('redis://127.0.0.1:1');
    const checker = new JobOwnership(redisUrl);
    const job = { id: 'own-fixture-id', queueQualifiedName: prefix };
    try {
      const started = Date.now();
      await expect(unavailable.start()).rejects.toThrow();
      await expect(unavailable.authorize(job, 'private-token')).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(Date.now() - started).toBeLessThan(2_000);
      await checker.start();
      const controller = checker.track('own-fixture-id');
      checker.close();
      await expect(checker.authorize(job, 'private-token')).rejects.toMatchObject({ kind: 'lock_lost' });
      // Explicit checker shutdown fails closed synchronously, without waiting for socket events.
      expect(controller.signal.aborted).toBe(true);
    } finally { unavailable.close(); checker.close(); }
  });
});
