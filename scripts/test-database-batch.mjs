import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PrismaService } from '../dist/src/infra/database/prisma.service.js';
import { LotsRepository } from '../dist/src/infra/database/repositories/lots.repository.js';

const expectedUrl = 'postgres://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma';
if (process.env.DATABASE_URL !== expectedUrl) {
  throw new Error(`Refusing benchmark: DATABASE_URL must exactly equal ${expectedUrl}`);
}

const COUNT = 15_000;
const sourceId = `batch-benchmark-${process.pid}-${Date.now()}`;
const prisma = PrismaService.getInstance();
const repository = new LotsRepository(prisma);
const lots = (bid) => Array.from({ length: COUNT }, (_, index) => ({
  sourceId,
  externalId: `batch-${String(index).padStart(5, '0')}`,
  titleRaw: 'Honda Civic 2020',
  closingModel: 'timer_por_lote',
  auctionStartUtc: new Date('2026-10-10T10:00:00.000Z'),
  auctionEndUtc: new Date('2026-10-12T10:00:00.000Z'),
  sourceTz: 'America/Sao_Paulo',
  status: 'aberto',
  currentBid: bid,
  photos: [],
}));

let firstElapsedMs;
let secondElapsedMs;
try {
  await prisma.$connect();
  await prisma.sources.create({ data: { id: sourceId, name: 'Isolated 15k batch benchmark', method: 'html' } });

  let started = performance.now();
  const first = await repository.upsertLots(lots(100));
  firstElapsedMs = Math.round(performance.now() - started);
  assert.equal(first.upserted, COUNT);
  assert.equal(first.novos.length, COUNT);
  assert.equal(first.bidChanges.length, 0);

  started = performance.now();
  const second = await repository.upsertLots(lots(200));
  secondElapsedMs = Math.round(performance.now() - started);
  assert.equal(second.upserted, COUNT);
  assert.equal(second.novos.length, 0);
  assert.equal(second.bidChanges.length, COUNT);
  assert.ok(second.bidChanges.every((change) => change.oldBid === 100 && change.newBid === 200));

  const [lotCheck, historyCheck] = await Promise.all([
    prisma.$queryRaw`SELECT count(*)::int AS count, count(DISTINCT external_id)::int AS distinct_count,
                            count(*) FILTER (WHERE current_bid = 200)::int AS updated_count
                       FROM lots WHERE source_id=${sourceId}`,
    prisma.$queryRaw`SELECT count(*)::int AS count,
                            count(*) FILTER (WHERE bid = 100)::int AS initial_count,
                            count(*) FILTER (WHERE bid = 200)::int AS changed_count
                       FROM bid_history h JOIN lots l ON l.id=h.lot_id WHERE l.source_id=${sourceId}`,
  ]);
  assert.deepEqual(lotCheck[0], { count: COUNT, distinct_count: COUNT, updated_count: COUNT });
  assert.deepEqual(historyCheck[0], { count: COUNT * 2, initial_count: COUNT, changed_count: COUNT });

  console.log(JSON.stringify({
    database: 'radar_prisma fixture', count: COUNT,
    first: { elapsedMs: firstElapsedMs, upserted: first.upserted, newIds: first.novos.length },
    second: { elapsedMs: secondElapsedMs, upserted: second.upserted, newIds: second.novos.length, bidChanges: second.bidChanges.length },
    persistedLots: lotCheck[0], persistedHistory: historyCheck[0],
  }, null, 2));
} finally {
  await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
  await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
  await PrismaService.disconnectInstance();
}
