import { describe, expect, it } from '@jest/globals';
import { createCollectionContext } from '../../../dist/src/bootstrap/collection-context.js';
import { CollectionService } from '../../../dist/src/application/services/collection/collection.service.js';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';

describe('default headless collection providers on real PostgreSQL', () => {
  it('uses the existing Prisma singleton and real run/upsert providers with no publisher or HTTP context', async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' ||
        db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.pathname !== '/radar_prisma') {
      throw new Error('Refusing headless integration outside isolated radar_prisma fixture');
    }
    const sourceId = `phase5headless-${process.pid}-${Date.now()}`;
    const effects = [];
    let sourceCreated = false;
    const context = await createCollectionContext({ overrides: {
      lookupConnector: () => ({ collect: async () => ({ fetched: 1, skipped: 0, lots: [{
        sourceId, externalId: 'headless', titleRaw: 'Honda Civic 2020', closingModel: 'timer_por_lote',
        sourceTz: 'America/Sao_Paulo', status: 'aberto', currentBid: 100, photos: [],
      }] }) }),
      processarAposColeta: async ids => { effects.push('post'); expect(ids).toHaveLength(1); return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; },
    } });
    const prisma = context.app.get(PrismaService);
    try {
      expect(context.app.get(CollectionService)).toBe(context.service);
      expect(prisma).toBe(PrismaService.getInstance());
      expect(context.app.listen).toBeUndefined();
      await prisma.$executeRaw`INSERT INTO sources (id,name,method) VALUES (${sourceId}, ${'headless fixture'}, ${'html'})`;
      sourceCreated = true;
      let guards = 0;
      const result = await context.service.execute({ sourceId, limit: 1, job: 'collect:headless-fixture',
        authorizePersistence: () => { guards++; }, publish: async () => { effects.push('publish'); },
      });
      expect(guards).toBe(2);
      expect(result.upserted).toBe(1);
      expect(effects).toEqual(['post', 'publish']);
      expect(await prisma.lots.count({ where: { source_id: sourceId } })).toBe(1);
      expect(await prisma.bid_history.count({ where: { lots: { source_id: sourceId } } })).toBe(1);
      const [run] = await prisma.$queryRaw`SELECT ok,upserted,finished_at FROM collection_runs WHERE id=${result.runId}`;
      expect(run.ok).toBe(true);
      expect(Number(run.upserted)).toBe(1);
      expect(run.finished_at).not.toBeNull();
    } finally {
      try {
        if (sourceCreated) {
          await prisma.$executeRaw`DELETE FROM collection_runs WHERE source_id=${sourceId}`;
          await prisma.$executeRaw`DELETE FROM lots WHERE source_id=${sourceId}`;
          await prisma.$executeRaw`DELETE FROM sources WHERE id=${sourceId}`;
          expect(await prisma.sources.count({ where: { id: sourceId } })).toBe(0);
        }
      } finally { await context.close(); }
    }
  });
});
