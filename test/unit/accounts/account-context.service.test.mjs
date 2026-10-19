import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AccountContextService } from '../../../dist/src/application/services/accounts/account-context.service.js';
import { AccountContextRepository } from '../../../dist/src/infra/database/repositories/account-context.repository.js';
import { AccountContextError, buildMePayload } from '../../../dist/src/domain/accounts/account-context.js';
import * as compatibility from '../../../dist/src/core/account-context.js';
import { HttpPlatformModule } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../dist/src/infra/http/radar-http-context.js';
import { IdentityService } from '../../../dist/src/application/services/identity/identity.service.js';
import { AccountsModule } from '../../../dist/src/application/modules/accounts/accounts.module.js';
import { CatalogModule } from '../../../dist/src/application/modules/catalog/catalog.module.js';
import { PagesModule } from '../../../dist/src/application/modules/pages/pages.module.js';
import { AccountsService } from '../../../dist/src/application/services/accounts/accounts.service.js';
import { CatalogService } from '../../../dist/src/application/services/catalog/catalog.service.js';
import { PagesService } from '../../../dist/src/application/services/pages/pages.service.js';
import { authDependencies } from '../../e2e/auth/helpers/auth-fixture.mjs';

describe('AccountContextService validation, compatibility and native app scope', () => {
  it('rejects invalid owners/lists before any SQL, checks the 100-entry bound before deduplication and preserves source rows', async () => {
    const query = jest.fn(async () => [{ lot_id: 1 }]);
    const service = new AccountContextService(new AccountContextRepository(query));
    for (const owner of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, null]) {
      for (const run of [() => service.summarize(owner), () => service.decorateLots(owner, [])]) {
        await expect(run()).rejects.toMatchObject({ name: 'AccountContextError', statusCode: 401, message: 'Autenticação necessária.' });
      }
    }
    await expect(service.decorateLots(1, null)).rejects.toMatchObject({ statusCode: 400, message: 'Lista de lotes inválida.' });
    await expect(service.decorateLots(1, Array(101).fill({ id: 1 }))).rejects.toMatchObject({ statusCode: 400, message: 'Lista de lotes inválida.' });
    for (const id of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, null, '1']) {
      await expect(service.decorateLots(1, [{ id }])).rejects.toMatchObject({ statusCode: 400, message: 'Identificador de lote inválido.' });
    }
    expect(query).not.toHaveBeenCalled();
    expect(await service.decorateLots(1, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    const original = Array.from({ length: 100 }, () => ({ id: 1, favorited: false, ownField: 'kept' }));
    const result = await service.decorateLots(1, original);
    expect(result).toHaveLength(100);
    expect(result.every(row => row.favorited && row.ownField === 'kept')).toBe(true);
    expect(original.every(row => row.favorited === false)).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.any(String), [1, [1]]);
  });

  it('preserves error/helper identity and destructured compatibility methods, including the sequential query failure barrier', async () => {
    expect(compatibility.AccountContextError).toBe(AccountContextError);
    expect(compatibility.buildMePayload).toBe(buildMePayload);
    const query = jest.fn(async () => { throw Error('favorites failure'); });
    const { summarize } = compatibility.createAccountContext(query);
    await expect(summarize(11)).rejects.toThrow('favorites failure');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FROM favorites');
    query.mockClear();
    await expect(summarize(0)).rejects.toBeInstanceOf(AccountContextError);
    expect(query).not.toHaveBeenCalled();
    const calls = [];
    const bound = compatibility.createAccountContext(async (sql, params) => {
      calls.push({ sql, params });
      return sql.startsWith('SELECT lot_id') ? [{ lot_id: 2 }] : [{ count: '3' }];
    });
    const { summarize: summary, decorateLots } = bound;
    expect(await summary(11)).toEqual({ favoriteCount: 3, unreadAlertCount: 3 });
    expect(await decorateLots(11, [{ id: 2, favorited: false }, { id: 1, favorited: true }, { id: 2 }]))
      .toEqual([{ id: 2, favorited: true }, { id: 1, favorited: false }, { id: 2, favorited: true }]);
    expect(calls.map(call => call.params)).toEqual([[11], [11], [11, [2, 1]]]);
  });

  it('shares one real service across Accounts/Catalog/Pages per app and isolates two exact fake query ports without DB/Redis/OIDC env', async () => {
    const apps = [];
    try {
      const fixtures = await Promise.all([1, 2].map(async marker => {
        const { deps } = authDependencies();
        const calls = [];
        const query = async (sql, params) => {
          calls.push({ sql, params });
          return sql.startsWith('SELECT lot_id') ? [{ lot_id: marker }] : [{ count: marker }];
        };
        deps.data.query = query;
        class Root {}
        Module({ imports: [HttpPlatformModule.forRoot({
          dependencies: deps, env: { NODE_ENV: 'test', ANTIBOT_MODE: 'off' },
          paths: { projectRoot: process.cwd(), webRoot: '', appDist: '', certDir: '', dataDir: '' },
        }), AccountsModule, CatalogModule, PagesModule] })(Root);
        const app = await NestFactory.createApplicationContext(Root, { logger: false });
        apps.push(app);
        const service = app.get(AccountContextService);
        expect(service).toBeInstanceOf(AccountContextService);
        expect(app.get(AccountsService).accountContext).toBe(service);
        expect(app.get(CatalogService).accountContext).toBe(service);
        expect(app.get(PagesService).accountContext).toBe(service);
        expect(app.get(RadarHttpContext).data.query).toBe(query);
        expect(app.get(IdentityService)).toBe(deps.identity);
        expect(calls).toEqual([]);
        return { app, service, calls, marker };
      }));
      expect(fixtures[0].service).not.toBe(fixtures[1].service);
      expect(fixtures[0].app.get(AccountContextRepository)).not.toBe(fixtures[1].app.get(AccountContextRepository));
      await Promise.all(fixtures.map(async ({ service, calls, marker }) => {
        expect(await service.summarize(11)).toEqual({ favoriteCount: marker, unreadAlertCount: marker });
        expect((await service.decorateLots(11, [{ id: 2 }, { id: 1 }])).map(row => row.favorited))
          .toEqual(marker === 1 ? [false, true] : [true, false]);
        expect(calls.map(call => call.params)).toEqual([[11], [11], [11, [2, 1]]]);
      }));
    } finally { await Promise.all(apps.map(app => app.close())); }
  });
});
