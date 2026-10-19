import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { LotsRepository, upsertLots } from '../../../dist/src/infra/database/repositories/lots.repository.js';
import { executeCollection } from '../../../dist/src/application/services/collection/collection-execution.js';
import { observerForCollection } from '../../../dist/src/application/services/collection/collection-observer.js';
import { CollectionCancellationError } from '../../../dist/src/infra/collection/collection-cancellation.js';
import { startRun, finishRun } from '../../../dist/src/core/repo.js';
import { createConnection } from 'node:net';

describe('collection persistence control on real PostgreSQL', () => {
  let prisma;
  let repository;
  let sourceCreated = false;
  const sourceId = `phase5a-${process.pid}-${Date.now()}`;
  const lot = (externalId, overrides = {}) => ({
    sourceId, externalId, titleRaw: 'Honda Civic 2020', closingModel: 'timer_por_lote',
    sourceTz: 'America/Sao_Paulo', status: 'aberto', currentBid: 100, photos: [], ...overrides,
  });
  const batch = () => [
    lot('existing', { currentBid: 200 }),
    lot('new'),
    lot('close', { titleRaw: 'Quadro decorativo', assetType: 'outro' }),
  ];
  const snapshot = async () => ({
    lots: await prisma.lots.findMany({ where: { source_id: sourceId }, orderBy: { external_id: 'asc' } }),
    history: await prisma.bid_history.findMany({ where: { lots: { source_id: sourceId } }, orderBy: { id: 'asc' } }),
  });

  // Existing constructor injection seam; all statements still execute on the real transaction.
  function observedRepository(afterStatement) {
    return new LotsRepository({
      $transaction: (callback, options) => prisma.$transaction(async tx => {
        const client = Object.fromEntries(['$queryRawUnsafe', '$executeRawUnsafe'].map(method => [method, async (sql, ...params) => {
          const result = await tx[method](sql, ...params);
          await afterStatement(sql, tx);
          return result;
        }]));
        return callback(client);
      }, options),
    });
  }

  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' ||
        db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.pathname !== '/radar_prisma') {
      throw new Error('Refusing test outside isolated 127.0.0.1:55433/radar_prisma fixture');
    }
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: 55433 });
      socket.setTimeout(2_000);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
      socket.once('timeout', () => { socket.destroy(); reject(new Error('Isolated PostgreSQL fixture unavailable')); });
    });
    prisma = PrismaService.getInstance();
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    repository = new LotsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${sourceId}, ${'phase5 persistence control'}, ${'html'})`;
    sourceCreated = true;
    await repository.upsertLots([lot('existing'), lot('close')]);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      if (!sourceCreated) return;
      await prisma.$executeRaw`DELETE FROM tenant_collection_attempts WHERE source_id=${sourceId}`;
      await prisma.$executeRaw`DELETE FROM collection_runs WHERE source_id=${sourceId}`;
      await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
      await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
    } finally { await PrismaService.disconnectInstance(); }
  });

  it('pre-aborted signal or initial authority denial executes no write statements', async () => {
    const before = await snapshot();
    let statements = 0;
    const observed = observedRepository(async () => { statements++; });
    const controller = new AbortController();
    const failure = new CollectionCancellationError('shutdown');
    controller.abort(failure);
    let guards = 0;
    await expect(observed.upsertLots(batch(), { signal: controller.signal, authorizePersistence: () => { guards++; } })).rejects.toBe(failure);
    await expect(observed.upsertLots(batch(), { authorizePersistence: () => { throw failure; } })).rejects.toBe(failure);
    expect(guards).toBe(0);
    expect(statements).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('aborts after actual update/history, before the next out-of-scope iteration, and awaits rollback', async () => {
    const before = await snapshot();
    const controller = new AbortController();
    const failure = new CollectionCancellationError('lock_lost');
    let writes = 0;
    let guards = 0;
    const observed = observedRepository(async (sql, tx) => {
      if (/^\s*(INSERT|UPDATE)/.test(sql)) writes++;
      if (sql.startsWith('INSERT INTO bid_history')) {
        const [row] = await tx.$queryRawUnsafe('SELECT current_bid FROM lots WHERE source_id=$1 AND external_id=$2', sourceId, 'existing');
        expect(Number(row.current_bid)).toBe(200);
        controller.abort(failure);
      }
    });
    await expect(observed.upsertLots([batch()[0], batch()[2], batch()[1]], {
      signal: controller.signal, authorizePersistence: () => { guards++; },
    })).rejects.toBe(failure);
    expect(writes).toBe(2); // Real lot UPDATE (upsert) and real history INSERT, not a pre-write abort.
    expect(guards).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it('final denial after all real writes rolls back new/update/closing/history and closes real ledgers without effects', async () => {
    const before = await snapshot();
    const failure = new CollectionCancellationError('lock_lost');
    let guards = 0;
    let writes = 0;
    let effects = 0;
    let runId;
    const observed = observedRepository(async (sql, tx) => {
      if (/^\s*(INSERT|UPDATE)/.test(sql)) writes++;
      if (sql.trimStart().startsWith('UPDATE lots')) {
        const rows = await tx.$queryRawUnsafe('SELECT external_id,status,current_bid FROM lots WHERE source_id=$1', sourceId);
        expect(rows).toHaveLength(3);
        expect(rows.find(row => row.external_id === 'existing').current_bid.toString()).toBe('200');
        expect(rows.find(row => row.external_id === 'close').status).toBe('encerrado');
      }
    });
    await expect(executeCollection({
      sourceId, tenant: 'fixture.example.test', guaranteeTenantAttempt: true, limit: 3,
      authorizePersistence: () => { if (++guards === 2) throw failure; },
      publish: async () => { effects++; },
    }, {
      lookupConnector: () => ({ collect: async () => ({ lots: batch(), fetched: 3, skipped: 0, httpStatus: 200 }) }),
      startRun: async (...args) => { runId = await startRun(...args); return runId; },
      finishRun, upsertLots: observed.upsertLots.bind(observed), observerForCollection: context => observerForCollection(context, true),
      processarAposColeta: async () => { effects++; return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; },
      publishNotification: async () => { effects++; },
    })).rejects.toBe(failure);
    expect(guards).toBe(2);
    expect(writes).toBe(5);
    expect(effects).toBe(0);
    expect(await snapshot()).toEqual(before);
    const [run] = await prisma.$queryRaw`SELECT ok,upserted,finished_at FROM collection_runs WHERE id=${runId}`;
    expect(run.ok).toBe(false);
    expect(Number(run.upserted)).toBe(0);
    expect(run.finished_at).not.toBeNull();
    const [attempt] = await prisma.$queryRaw`SELECT state,error_kind,returned,finished_at FROM tenant_collection_attempts WHERE run_id=${runId}`;
    expect(attempt.state).toBe('partial');
    expect(attempt.error_kind).toBe('network');
    expect(attempt.returned).toBe(3);
    expect(attempt.finished_at).not.toBeNull();
  });

  it('abort observed after the last closing statement rolls back rather than committing', async () => {
    const before = await snapshot();
    const controller = new AbortController();
    const failure = new CollectionCancellationError('shutdown');
    let guards = 0;
    let closingCompleted = false;
    const observed = observedRepository(async sql => {
      if (sql.trimStart().startsWith('UPDATE lots')) { closingCompleted = true; controller.abort(failure); }
    });
    await expect(observed.upsertLots(batch(), { signal: controller.signal, authorizePersistence: () => { guards++; } })).rejects.toBe(failure);
    expect(closingCompleted).toBe(true);
    expect(guards).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it('exported optional-control API commits all changes with exactly two authority checks', async () => {
    let guards = 0;
    const outcome = await upsertLots(batch(), { authorizePersistence: () => { guards++; } });
    expect(guards).toBe(2);
    expect(outcome.upserted).toBe(2);
    expect(outcome.novos).toHaveLength(1);
    const rows = await prisma.lots.findMany({ where: { source_id: sourceId } });
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.external_id === 'close').status).toBe('encerrado');
    expect(rows.find(row => row.external_id === 'existing').current_bid.toString()).toBe('200');
    expect(await prisma.bid_history.count({ where: { lots: { source_id: sourceId } } })).toBe(4);
  });
});
