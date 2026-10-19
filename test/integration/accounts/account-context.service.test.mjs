import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { query } from '../../../dist/src/infra/database/query.js';
import { AccountContextService } from '../../../dist/src/application/services/accounts/account-context.service.js';
import { AccountsService } from '../../../dist/src/application/services/accounts/accounts.service.js';
import { HttpPlatformModule } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { AccountsModule } from '../../../dist/src/application/modules/accounts/accounts.module.js';
import { authDependencies } from '../../e2e/auth/helpers/auth-fixture.mjs';

describe('per-app account context with real isolated PostgreSQL', () => {
  const prefix = `accountcontext5-${process.pid}-${Date.now()}`;
  const users = [], lots = [], alerts = [];
  let prisma, app, service, sourceCreated = false;

  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' || db.pathname !== '/radar_prisma' ||
        db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.search || db.hash) {
      throw Error('Refusing account context integration outside exact isolated radar_prisma fixture');
    }
    prisma = PrismaService.getInstance();
    await prisma.$connect();
    await prisma.sources.create({ data: { id: prefix, name: prefix, method: 'html' } });
    sourceCreated = true;
    for (const suffix of ['a', 'b']) {
      users.push(await prisma.users.create({ data: { sub: `${prefix}-${suffix}`, nome: suffix, papel: 'comum' } }));
    }
    for (const [external_id, status] of [['open-a', 'aberto'], ['open-b', 'aberto'], ['sold', 'vendido'], ['closed', 'encerrado'], ['expired', 'aberto']]) {
      lots.push(await prisma.lots.create({ data: {
        source_id: prefix, external_id, title_raw: 'Honda Civic', status, closing_model: 'timer_por_lote',
        auction_end_utc: external_id === 'expired' ? new Date(Date.now() - 3600_000) : null,
      } }));
    }
    for (const lotIndex of [0, 2, 3, 4]) await prisma.favorites.create({ data: { owner_id: users[0].id, lot_id: lots[lotIndex].id } });
    for (const lotIndex of [0, 1]) await prisma.favorites.create({ data: { owner_id: users[1].id, lot_id: lots[lotIndex].id } });
    for (const user of users) alerts.push(await prisma.alerts.create({ data: { owner_id: user.id, label: prefix } }));
    for (const [owner, lotIndex, seen] of [[0, 0, false], [0, 4, false], [0, 2, true], [1, 1, false], [1, 0, true]]) {
      await prisma.alert_hits.create({ data: { alert_id: alerts[owner].id, lot_id: lots[lotIndex].id, seen } });
    }
    const { deps } = authDependencies();
    deps.data.query = query; // Actual Prisma parameter binding; no SQL result doubles.
    class Root {}
    Module({ imports: [HttpPlatformModule.forRoot({
      dependencies: deps, env: { NODE_ENV: 'test', ANTIBOT_MODE: 'off' },
      paths: { projectRoot: process.cwd(), webRoot: '', appDist: '', certDir: '', dataDir: '' },
    }), AccountsModule] })(Root);
    app = await NestFactory.createApplicationContext(Root, { logger: false, abortOnError: false });
    service = app.get(AccountContextService);
  }, 60_000);

  afterAll(async () => {
    try {
      if (prisma && sourceCreated) {
        await prisma.users.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
        await prisma.lots.deleteMany({ where: { source_id: prefix } });
        await prisma.sources.delete({ where: { id: prefix } });
        expect(await prisma.users.count({ where: { sub: { startsWith: prefix } } })).toBe(0);
        expect(await prisma.alerts.count({ where: { id: { in: alerts.map(alert => alert.id) } } })).toBe(0);
        expect(await prisma.alert_hits.count({ where: { alert_id: { in: alerts.map(alert => alert.id) } } })).toBe(0);
        expect(await prisma.favorites.count({ where: { owner_id: { in: users.map(user => user.id) } } })).toBe(0);
        expect(await prisma.lots.count({ where: { source_id: prefix } })).toBe(0);
      }
    } finally {
      try { await app?.close(); } finally { await PrismaService.disconnectInstance(); }
    }
  });

  it('counts only each owner’s visible favorites but all their unread hits, excluding sold/closed/expired favorites', async () => {
    expect(service).toBeInstanceOf(AccountContextService);
    expect(await service.summarize(Number(users[0].id))).toEqual({ favoriteCount: 1, unreadAlertCount: 2 });
    expect(await service.summarize(Number(users[1].id))).toEqual({ favoriteCount: 2, unreadAlertCount: 1 });
    expect(await prisma.favorites.count({ where: { owner_id: users[0].id } })).toBe(4);
  });

  it('decorates membership even for hidden favorites without leaking other owners, changing order or mutating stale inputs', async () => {
    const input = [4, 1, 0, 4, 3].map((index, i) => ({ id: Number(lots[index].id), favorited: i % 2 === 0, fixtureIndex: index }));
    const snapshot = structuredClone(input);
    const a = await service.decorateLots(Number(users[0].id), input);
    const b = await service.decorateLots(Number(users[1].id), input);
    expect(a.map(row => row.favorited)).toEqual([true, false, true, true, true]);
    expect(b.map(row => row.favorited)).toEqual([false, true, true, false, false]);
    expect(a.map(row => row.id)).toEqual(input.map(row => row.id));
    expect(b.map(row => row.fixtureIndex)).toEqual(input.map(row => row.fixtureIndex));
    expect(input).toEqual(snapshot);
  });

  it('injects the real per-app service into /me application logic and reflects only that owner’s persisted seen/favorite changes', async () => {
    const accounts = app.get(AccountsService);
    expect(accounts.accountContext).toBe(service);
    const actor = { userId: Number(users[0].id), sub: users[0].sub, nome: users[0].nome, email: null, papel: 'comum' };
    expect(await accounts.me(actor, { oidc: true, saiuEmDev: false })).toEqual({
      papel: 'comum', oidc: true, logado: true,
      conta: { id: actor.userId, email: null, nome: 'a', porProvedor: true },
      favoriteCount: 1, unreadAlertCount: 2,
    });
    await prisma.alert_hits.updateMany({ where: { alert_id: alerts[0].id }, data: { seen: true } });
    await prisma.favorites.delete({ where: { owner_id_lot_id: { owner_id: users[0].id, lot_id: lots[0].id } } });
    expect(await service.summarize(actor.userId)).toEqual({ favoriteCount: 0, unreadAlertCount: 0 });
    expect(await service.summarize(Number(users[1].id))).toEqual({ favoriteCount: 2, unreadAlertCount: 1 });
    expect((await service.decorateLots(actor.userId, [{ id: Number(lots[0].id) }]))[0].favorited).toBe(false);
  });
});
