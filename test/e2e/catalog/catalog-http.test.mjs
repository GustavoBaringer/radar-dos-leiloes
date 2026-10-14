import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { catalogDependencies } from './helpers/catalog-fixture.mjs';
import { CatalogModule } from '../../../dist/src/application/modules/catalog/catalog.module.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { criarToken } from '../../../dist/src/core/auth.js';

jest.setTimeout(30_000);

describe('catalog HTTP module', () => {
  let app;
  let state;
  async function start(options = {}) {
    const fixture = catalogDependencies(options);
    state = fixture.state;
    const env = { NODE_ENV: 'test', ANTIBOT_MODE: 'off' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class CatalogTestRoot {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), CatalogModule] })(CatalogTestRoot);
    app = await NestFactory.create(CatalogTestRoot, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    await configureHttpPlatform(app, app.get(RADAR_HTTP_CONTEXT));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  const cookie = (sub = 'user-one', papel = 'admin') => `radar_sessao=${criarToken(papel, sub)}`;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('rejects anonymous protected search before database access', async () => {
    const server = await start();
    const response = await request(server).get('/api/search');
    expect(response.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });

  it('serves the public vitrine anonymously using the bounded aggregate contract', async () => {
    const server = await start();
    const response = await request(server).get('/api/vitrine');
    expect(state.unexpected).toEqual([]);
    expect(response.status).toBe(200);
    expect(response.body.categorias).toHaveLength(6);
    expect(response.body.recentes).toHaveLength(1);
    expect(state.queries).toHaveLength(9);
  });

  it('serves brands and HEAD with no-store, while server role gates stats and sources', async () => {
    const server = await start();
    const brands = await request(server).get('/api/brands').set('Cookie', cookie('user-one', 'admin'));
    expect(brands.status).toBe(200);
    expect(brands.body).toEqual({ known: expect.any(Array), present: [{ brand: 'FORD', count: 4 }] });
    expect(brands.headers['cache-control']).toContain('no-store');
    const head = await request(server).head('/api/brands').set('Cookie', cookie());
    expect(head.status).toBe(200);
    expect(head.text ?? '').toBe('');
    const before = state.queries.length;
    expect((await request(server).get('/api/stats').set('Cookie', cookie())).status).toBe(403);
    expect((await request(server).get('/api/sources').set('Cookie', cookie())).status).toBe(403);
    expect(state.queries).toHaveLength(before);
  });

  it('rejects malformed search queries before database access', async () => {
    const server = await start();
    const response = await request(server).get('/api/search?onlyWithPhoto=maybe').set('Cookie', cookie());
    expect(response.status).toBe(400);
    expect(state.queries).toHaveLength(0);
  });

  it('parses CSV/multivalue filters and decorates search results for the authenticated owner', async () => {
    const server = await start();
    const response = await request(server).get('/api/search?uf=SP%2CRJ&uf=MG&pageSize=5').set('Cookie', cookie('user-two'));
    expect(state.unexpected).toEqual([]);
    expect(response.status).toBe(200);
    expect(response.body.items[0].favorited).toBe(true);
    const favoritesQuery = state.queries.find(({ sql }) => sql.includes('SELECT lot_id FROM favorites'));
    expect(favoritesQuery.params).toEqual([22, [101]]);
  });

  it('returns the legacy detail 404 envelope without exposing SQL details', async () => {
    const server = await start({ detailMissing: true });
    const response = await request(server).get('/api/lot/101').set('Cookie', cookie());
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ erro: 'lote não encontrado' });
  });

  it('keeps invalid-id envelope and omits internal provenance from common-user details', async () => {
    const server = await start();
    const invalid = await request(server).get('/api/lot/0').set('Cookie', cookie());
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'id inválido' });
    expect(state.queries).toHaveLength(0);
    const response = await request(server).get('/api/lot/101').set('Cookie', cookie());
    expect(response.status).toBe(200);
    expect(response.body.source_tz).toBeUndefined();
    expect(response.body.collected_at).toBeUndefined();
  });

  it('masks repository failures and releases read admission for a subsequent request', async () => {
    const server = await start({ failBrandsOnce: true });
    const failed = await request(server).get('/api/brands').set('Cookie', cookie());
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'erro interno' });
    expect(JSON.stringify(failed.body)).not.toContain('secret database detail');
    const retried = await request(server).get('/api/brands').set('Cookie', cookie());
    expect(retried.status).toBe(200);
  });
});
