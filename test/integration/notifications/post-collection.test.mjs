import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import { CollectionModule } from '../../../dist/src/application/modules/collection/collection.module.js';
import { NotificationsModule } from '../../../dist/src/application/modules/notifications/notifications.module.js';
import { CollectionService } from '../../../dist/src/application/services/collection/collection.service.js';
import { PostCollectionService } from '../../../dist/src/application/services/collection/post-collection.js';
import { NotificationService } from '../../../dist/src/application/services/notifications/notification.service.js';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { NotificationSubscriptionsRepository } from '../../../dist/src/infra/database/repositories/notification-subscriptions.repository.js';
import { avaliarAlertas, contarCasaveis, marcarNotificado } from '../../../dist/src/infra/database/repositories/alerts.repository.js';

jest.setTimeout(60_000);

describe('real PostgreSQL alert matching and native post-collection composition', () => {
  let prisma, app, sourceId, users, alerts, ports, warnings;
  let sent, attempted, published;
  const id = value => Number(value);

  beforeEach(async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' ||
        db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.pathname !== '/radar_prisma' ||
        db.search || db.hash) throw Error('Refusing notification integration outside exact isolated radar_prisma fixture');
    prisma = PrismaService.getInstance();
    await prisma.$connect();
    // Evaluation updates last_run_at for every enabled alert. Refuse other data rather than modify it.
    if (await prisma.alerts.count() || await prisma.push_subscriptions.count()) throw Error('Notification fixture requires no preexisting alerts/subscriptions');
    sourceId = `notifications5-${process.pid}-${Date.now()}`;
    users = [];
    alerts = [];
    sent = []; attempted = []; published = [];
    warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await prisma.sources.create({ data: { id: sourceId, name: sourceId, method: 'html' } });
    for (const owner of ['a', 'b']) {
      const user = await prisma.users.create({ data: { sub: `${sourceId}-${owner}`, email: `${owner}@example.test` } });
      users.push(user);
      alerts.push(await prisma.alerts.create({ data: {
        owner_id: user.id, label: 'Mesmo nome', q: 'honda civic', email: user.email,
        created_at: new Date(Date.now() - 60_000), channels: ['sino', 'push', 'email'],
        filters: { sourceId, assetType: 'veiculo', vehicleType: 'carro,suv', uf: 'sp,rj', priceMax: 50000, yearMin: 2019 },
      } }));
      await prisma.push_subscriptions.create({ data: { endpoint: `${sourceId}-${owner}`, owner_id: user.id, p256dh: 'fake', auth: 'fake' } });
    }
    for (const endpoint of ['dead404', 'dead410', 'disabled']) {
      await prisma.push_subscriptions.create({ data: {
        endpoint: `${sourceId}-${endpoint}`, owner_id: users[0].id, p256dh: 'fake', auth: 'fake', failures: endpoint === 'disabled' ? 5 : 0,
      } });
    }
    ports = {
      repository: new NotificationSubscriptionsRepository(),
      push: { enabled: true, send: async (subscription, payload) => {
        attempted.push(subscription.endpoint);
        if (subscription.endpoint.endsWith('dead404')) throw { statusCode: 404 };
        if (subscription.endpoint.endsWith('dead410')) throw { statusCode: 410 };
        if (subscription.endpoint.endsWith('-b')) throw { statusCode: 503 };
        sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      } },
      env: { SMTP_HOST: 'fake-no-network' },
      smtp: async () => ({ sendMail: async message => { if (message.to === 'b@example.test') throw Error('fake SMTP failure'); } }),
      mark: marcarNotificado,
    };
    const module = CollectionModule.forRoot({ overrides: {
      lookupConnector: () => ({ collect: async () => ({ fetched: 1, skipped: 0, lots: [{
        sourceId, externalId: 'collected', titleRaw: 'Honda Civic 2020', assetType: 'veiculo', vehicleType: 'carro',
        state: 'SP', currentBid: 10000, closingModel: 'timer_por_lote', status: 'aberto', photos: [],
      }] }) }),
      publishNotification: async payload => { published.push(payload); },
    } });
    // Substitute only transport ports in the production dynamic graph, not its collection/post providers.
    module.imports = module.imports.map(imported => imported.module === NotificationsModule ? NotificationsModule.forRoot(ports) : imported);
    app = await NestFactory.createApplicationContext(module, { logger: false, abortOnError: false });
  });

  afterEach(async () => {
    try {
      if (sourceId) {
        await prisma.users.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
        await prisma.collection_runs.deleteMany({ where: { source_id: sourceId } });
        await prisma.lots.deleteMany({ where: { source_id: sourceId } });
        await prisma.sources.deleteMany({ where: { id: sourceId } });
        expect(await prisma.users.count({ where: { sub: { startsWith: sourceId } } })).toBe(0);
        expect(await prisma.lots.count({ where: { source_id: sourceId } })).toBe(0);
        expect(await prisma.alert_hits.count({ where: { alert_id: { in: alerts.map(alert => alert.id) } } })).toBe(0);
      }
    } finally {
      sourceId = undefined;
      warnings?.mockRestore();
      if (app) {
        const destroy = jest.spyOn(prisma, 'onModuleDestroy');
        try { await app.close(); expect(destroy).toHaveBeenCalledTimes(1); }
        finally { destroy.mockRestore(); }
      } else await PrismaService.disconnectInstance();
      app = undefined;
    }
  });

  async function lot(external_id, changes = {}) {
    return prisma.lots.create({ data: {
      source_id: sourceId, external_id, title_raw: 'Honda Civic 2020', search_text: 'honda civic 2020',
      brand: 'HONDA', model: 'CIVIC', year_model: 2020, vehicle_type: 'carro', asset_type: 'veiculo',
      state: 'SP', current_bid: 10000, status: 'aberto', closing_model: 'timer_por_lote',
      ...changes,
    } });
  }

  async function hitsFor(row) {
    return (await prisma.alert_hits.findMany({ where: { lot_id: row.id }, orderBy: { alert_id: 'asc' } }))
      .map(hit => ({ alertId: id(hit.alert_id), notified: hit.notified }));
  }

  it('executes matching filters, candidate count and idempotent hit insertion against actual PostgreSQL', async () => {
    const fresh = await lot('fresh');
    const blocked = await Promise.all([
      lot('old', { first_seen_at: new Date(Date.now() - 3600_000) }),
      lot('unrelated', { brand: 'FIAT', model: 'UNO', search_text: 'fiat uno' }),
      lot('closed', { status: 'encerrado' }), lot('sold', { status: 'vendido' }),
      lot('expired', { auction_end_utc: new Date(Date.now() - 3600_000) }),
      lot('out-of-scope', { asset_type: 'outro' }), lot('wrong-state', { state: 'MG' }),
      lot('wrong-type', { vehicle_type: 'moto' }), lot('expensive', { current_bid: 60000 }),
      lot('old-year', { year_model: 2018 }),
    ]);
    expect(await contarCasaveis({ ...alerts[0], id: id(alerts[0].id), owner_id: id(users[0].id) })).toBe(2);
    expect(await prisma.alert_hits.count()).toBe(0);
    const ids = [fresh, ...blocked].map(row => id(row.id));
    const first = await avaliarAlertas(ids);
    expect(first.map(hit => [hit.alertId, hit.ownerId, hit.lotId])).toEqual(alerts.map((alert, i) => [id(alert.id), id(users[i].id), id(fresh.id)]));
    expect(await avaliarAlertas(ids)).toEqual([]);
    expect(await prisma.alert_hits.count()).toBe(2);
    expect((await hitsFor(fresh)).map(hit => hit.notified)).toEqual([[], []]);
  });

  it('publishes after hits commit, isolates owners and persists only successful channels while cleaning dead subscriptions', async () => {
    const fresh = await lot('delivered');
    const post = app.get(PostCollectionService);
    const result = await post.processarAposColeta([id(fresh.id)], async payload => {
      expect(await prisma.alert_hits.count()).toBe(2);
      published.push(payload);
    });
    expect(result).toEqual({ disparos: 2, push: 1, emails: 1, pendentesEmail: 1, adiados: 0 });
    expect(published[0].disparos.map(hit => hit.ownerId)).toEqual(users.map(user => id(user.id)));
    expect(sent.map(message => message.endpoint)).toEqual([`${sourceId}-a`]);
    expect(sent[0].payload.url).toBe(`/alertas?alertId=${alerts[0].id}`);
    expect(attempted).not.toContain(`${sourceId}-disabled`);
    expect(await hitsFor(fresh)).toEqual([{ alertId: id(alerts[0].id), notified: ['push', 'email'] }, { alertId: id(alerts[1].id), notified: [] }]);
    expect(await prisma.push_subscriptions.count({ where: { endpoint: { in: [`${sourceId}-dead404`, `${sourceId}-dead410`] } } })).toBe(0);
    expect((await prisma.push_subscriptions.findUnique({ where: { endpoint: `${sourceId}-b` } })).failures).toBe(1);
    expect(await post.processarAposColeta([id(fresh.id)])).toEqual({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 });
  });

  it('uses persisted independent push/email budget windows and leaves absent SMTP deliveries pending', async () => {
    const previous = await lot('previous');
    for (const [i, alert] of alerts.entries()) {
      await prisma.alert_hits.create({ data: { alert_id: alert.id, lot_id: previous.id, notified: [i === 0 ? 'push' : 'email'] } });
    }
    const fresh = await lot('budget');
    ports.env = {};
    const result = await app.get(PostCollectionService).processarAposColeta([id(fresh.id)], undefined, { push: 60, email: 60 });
    expect(result).toEqual({ disparos: 2, push: 0, emails: 0, pendentesEmail: 1, adiados: 2 });
    expect(sent).toEqual([]);
    expect(attempted).toEqual([`${sourceId}-b`]);
    expect((await hitsFor(fresh)).map(hit => hit.notified)).toEqual([[], []]);
    expect((await hitsFor(previous)).map(hit => hit.notified)).toEqual([['push'], ['email']]);
  });

  it('uses the default DI post service after real collection persistence, honors explicit overrides and closes one Prisma singleton', async () => {
    expect(app.get(PrismaService)).toBe(prisma);
    expect(app.get(PostCollectionService)).toBe(await app.resolve(PostCollectionService));
    expect(app.get(NotificationService)).toBe(await app.resolve(NotificationService));
    const collection = app.get(CollectionService);
    const result = await collection.execute({ sourceId, limit: 1 });
    expect(result.upserted).toBe(1);
    expect(result.notifications).toEqual({ disparos: 2, push: 1, emails: 1, pendentesEmail: 1, adiados: 0 });
    expect(published).toHaveLength(1);
    const [fresh] = await prisma.lots.findMany({ where: { source_id: sourceId } });
    expect((await hitsFor(fresh)).map(hit => hit.notified)).toEqual([['push', 'email'], []]);
    let overrides = 0;
    await collection.execute({ sourceId, limit: 1 }, { processarAposColeta: async () => { overrides++; return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; } });
    expect(overrides).toBe(1);
    expect(published).toHaveLength(1);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failedNotice = await collection.execute({ sourceId, limit: 1 }, {
        lookupConnector: () => ({ collect: async () => ({ fetched: 1, skipped: 0, lots: [{
          sourceId, externalId: 'publish-failure', titleRaw: 'Honda Civic 2020', assetType: 'veiculo', vehicleType: 'carro',
          state: 'SP', currentBid: 10000, closingModel: 'timer_por_lote', status: 'aberto', photos: [],
        }] }) }),
        publishNotification: async () => { throw Error('fake publisher failed after hit commit'); },
      });
      expect(failedNotice.upserted).toBe(1);
      expect(failedNotice.notifications).toEqual({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 });
      const committed = await prisma.lots.findUnique({ where: { source_id_external_id: { source_id: sourceId, external_id: 'publish-failure' } } });
      expect((await hitsFor(committed)).map(hit => hit.notified)).toEqual([[], []]);
      expect(error).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); }
    expect((await prisma.collection_runs.findMany({ where: { source_id: sourceId } })).every(run => run.ok)).toBe(true);
  });
});
