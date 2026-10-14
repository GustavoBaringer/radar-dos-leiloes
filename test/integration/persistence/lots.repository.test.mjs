import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { LotsRepository } from '../../../dist/src/infra/database/repositories/lots.repository.js';
import { query } from '../../../dist/src/core/db.js';

describe('Prisma lots persistence', () => {
  let prisma;
  let repository;
  const sourceId = `phase3b-${process.pid}-${Date.now()}`;
  const start = new Date('2026-10-10T10:00:00.000Z');
  const nextStart = new Date('2026-10-11T10:00:00.000Z');
  const lot = (externalId, overrides = {}) => ({
    sourceId,
    externalId,
    titleRaw: 'Honda Civic 2020',
    closingModel: 'timer_por_lote',
    auctionStartUtc: start,
    auctionEndUtc: new Date('2026-10-12T10:00:00.000Z'),
    sourceTz: 'America/Sao_Paulo',
    status: 'aberto',
    currentBid: 100,
    photos: [],
    ...overrides,
  });

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL must target the isolated radar_prisma fixture');
    const db = new URL(url);
    if (db.hostname !== '127.0.0.1' || db.port !== '55433' || db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.pathname !== '/radar_prisma') {
      throw new Error('Refusing persistence integration test outside radar_prisma fixture');
    }
    prisma = PrismaService.getInstance();
    repository = new LotsRepository(prisma);
    await prisma.$connect();
    await prisma.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${sourceId}, ${'phase3b integration'}, ${'html'})`;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
      await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
      await PrismaService.disconnectInstance();
    }
  });

  it('preserves same-auction end, clears relisted end, records only changed bids, closes out-of-scope items', async () => {
    const first = await repository.upsertLots([lot('flow', { currentBid: 100 })]);
    expect(first.upserted).toBe(1);
    expect(first.novos).toHaveLength(1);

    const sameAuction = await repository.upsertLots([lot('flow', { auctionEndUtc: null, currentBid: 100 })]);
    expect(sameAuction.bidChanges).toHaveLength(0);
    let row = await prisma.lots.findUnique({ where: { source_id_external_id: { source_id: sourceId, external_id: 'flow' } } });
    expect(row.auction_end_utc).toEqual(new Date('2026-10-12T10:00:00.000Z'));

    await repository.upsertLots([lot('flow', { auctionStartUtc: nextStart, auctionEndUtc: null, currentBid: 125 })]);
    row = await prisma.lots.findUnique({ where: { source_id_external_id: { source_id: sourceId, external_id: 'flow' } } });
    expect(row.auction_end_utc).toBeNull();
    const history = await prisma.bid_history.findMany({ where: { lot_id: row.id } });
    expect(history.map((item) => item.bid.toString())).toEqual(['100', '125']);

    await repository.upsertLots([lot('close-me')]);
    const closed = await repository.upsertLots([lot('close-me', { titleRaw: 'Lote de quadro decorativo', assetType: 'outro' })]);
    expect(closed.upserted).toBe(0);
    row = await prisma.lots.findUnique({ where: { source_id_external_id: { source_id: sourceId, external_id: 'close-me' } } });
    expect(row.status).toBe('encerrado');
    expect(row.closed_reason).toBe('fora_escopo_asset_type_outro');
  });

  it('handles duplicate source ids in one batch and rolls back the whole batch after an intermediate failure', async () => {
    const duplicate = await repository.upsertLots([lot('duplicate'), lot('duplicate', { currentBid: 140 })]);
    expect(duplicate.upserted).toBe(2);
    expect(duplicate.novos).toHaveLength(1);
    expect(duplicate.bidChanges).toHaveLength(1);

    await expect(repository.upsertLots([
      lot('atomic-good', { currentBid: 99 }),
      lot('atomic-fail', { sourceId: `${sourceId}-missing` }),
    ])).rejects.toThrow();
    expect(await prisma.lots.count({ where: { source_id: sourceId, external_id: 'atomic-good' } })).toBe(0);
    expect(await prisma.bid_history.count({ where: { lots: { source_id: sourceId, external_id: 'atomic-good' } } })).toBe(0);
  });

  it('uses parameterized query values and preserves JSON values while converting SQL primitives', async () => {
    const hostile = "x'; DROP TABLE lots; --";
    const [result] = await query(
      'SELECT $1::text AS text, 1.25::numeric AS numeric, 42::bigint AS id, $2::jsonb AS raw',
      [hostile, JSON.stringify({ nested: '42' })],
    );
    expect(result).toEqual({ text: hostile, numeric: 1.25, id: 42, raw: { nested: '42' } });
    expect(await query('UPDATE lots SET status=status WHERE false')).toEqual([]);
    await expect(query('SELECT 9007199254740992::bigint AS id')).rejects.toThrow(RangeError);
  });
});
