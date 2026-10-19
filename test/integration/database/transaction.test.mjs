import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../../dist/src/infra/database/generated/client.js';
import { bigintToSafeNumber, decimalToNumber } from '../../../dist/src/infra/database/value-mappers.js';
import { withDatabaseTransaction } from '../../../dist/src/infra/database/transactions.js';

describe('database transaction contract', () => {
  let client;
  const committedSource = `phase2b-commit-${process.pid}-${Date.now()}`;
  const rolledBackSource = `phase2b-rollback-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL must point to isolated radar_prisma fixture');
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55433' || parsed.username !== 'radar_test' || parsed.password !== 'radar_test_local' || parsed.pathname !== '/radar_prisma') {
      throw new Error('Refusing integration test outside isolated radar_prisma fixture');
    }
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await client.$connect();
  });

  afterAll(async () => {
    if (client) {
      await client.$executeRaw`DELETE FROM lots WHERE source_id IN (${committedSource}, ${rolledBackSource})`;
      await client.$executeRaw`DELETE FROM sources WHERE id IN (${committedSource}, ${rolledBackSource})`;
      await client.$disconnect();
    }
  });

  it('commits source, lot and bid history atomically', async () => {
    const result = await withDatabaseTransaction(client, async (tx) => {
      await tx.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${committedSource}, ${'phase2b integration'}, ${'test'})`;
      const lots = await tx.$queryRaw`INSERT INTO lots (source_id, external_id, title_raw) VALUES (${committedSource}, ${'committed-lot'}, ${'integration test'}) RETURNING id`;
      await tx.$executeRaw`INSERT INTO bid_history (lot_id,bid) VALUES (${lots[0].id}, ${new Prisma.Decimal('10.25')})`;
      return lots[0].id;
    });
    expect(typeof result).toBe('bigint');
    const bids = await client.$queryRaw`SELECT bid FROM bid_history b JOIN lots l ON l.id=b.lot_id WHERE l.source_id=${committedSource}`;
    expect(bids).toHaveLength(1);
    expect(bids[0].bid.toString()).toBe('10.25');
  });

  it('rolls back lot and bid history together when transaction work fails', async () => {
    await expect(withDatabaseTransaction(client, async (tx) => {
      await tx.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${rolledBackSource}, ${'phase2b rollback'}, ${'test'})`;
      const lots = await tx.$queryRaw`INSERT INTO lots (source_id, external_id, title_raw) VALUES (${rolledBackSource}, ${'rollback-lot'}, ${'rollback test'}) RETURNING id`;
      await tx.$executeRaw`INSERT INTO bid_history (lot_id,bid) VALUES (${lots[0].id}, ${new Prisma.Decimal('12.50')})`;
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const counts = await client.$queryRaw`SELECT
      (SELECT count(*) FROM sources WHERE id=${rolledBackSource})::int sources,
      (SELECT count(*) FROM lots WHERE source_id=${rolledBackSource})::int lots,
      (SELECT count(*) FROM bid_history b JOIN lots l ON l.id=b.lot_id WHERE l.source_id=${rolledBackSource})::int bids`;
    expect(counts[0]).toEqual({ sources: 0, lots: 0, bids: 0 });
  });

  it('converts database numeric values explicitly and rejects unsafe BIGINT', () => {
    expect(decimalToNumber(new Prisma.Decimal('10.25'))).toBe(10.25);
    expect(decimalToNumber(null)).toBeNull();
    expect(bigintToSafeNumber(42n)).toBe(42);
    expect(() => bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});
