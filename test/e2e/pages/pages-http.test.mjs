import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { pagesDependencies } from './helpers/pages-fixture.mjs';
import { PagesModule } from '../../../dist/src/application/modules/pages/pages.module.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { configurePageAssets } from '../../../dist/src/infra/web/page-assets.js';
import { PagesService } from '../../../dist/src/application/services/pages/pages.service.js';
import { criarToken } from '../../../dist/src/infra/auth/session.js';

jest.setTimeout(30_000);

describe('pages HTTP module', () => {
  let app;
  let state;
  let context;
  async function start(options = {}) {
    const fixture = pagesDependencies(options);
    state = fixture.state;
    const env = { NODE_ENV: 'test', ANTIBOT_MODE: 'off', SITE_URL: 'https://radar.example' };
    const paths = {
      projectRoot: process.cwd(), webRoot: `${process.cwd()}/src/web`, appDist: `${process.cwd()}/app-busca/dist`,
      certDir: `${process.cwd()}/.tmp/pages-e2e-no-ca`, dataDir: `${process.cwd()}/data`,
    };
    class PagesTestRoot {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), PagesModule] })(PagesTestRoot);
    app = await NestFactory.create(PagesTestRoot, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    context = app.get(RADAR_HTTP_CONTEXT);
    await configureHttpPlatform(app, context);
    await configurePageAssets(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  const cookie = `radar_sessao=${criarToken('comum', 'fixture-user')}`;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('renders the existing landing template with asset versioning and no-cache', async () => {
    const server = await start();
    const response = await request(server).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.text).toContain('https://radar.example/');
    expect(response.text).toMatch(/\/landing\.css\?v=[a-z0-9]+/);
  });

  it('protects SPA routes for anonymous visitors and serves the existing shell to a resolved account', async () => {
    const server = await start();
    const denied = await request(server).get('/alertas');
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe('/login?de=%2Falertas');
    const allowed = await request(server).get('/alertas').set('Cookie', cookie);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-cache');
    expect(allowed.text).toContain('<div id="root"></div>');
  });

  it('redirects malformed/missing lots and returns canonical mismatch as 404 without-store', async () => {
    const server = await start({ missingLot: true });
    const malformed = await request(server).get('/lote/not-a-valid-slug').set('Cookie', cookie);
    expect(malformed.status).toBe(302);
    expect(malformed.headers.location).toBe('/busca');
    expect(malformed.headers['cache-control']).toContain('no-store');
    const missing = await request(server).get('/lote/honda-civic-2018-crlv-fixture-42').set('Cookie', cookie);
    expect(missing.status).toBe(302);
    expect(state.getLotCalls).toHaveLength(1);
  });

  it('keeps crawler SSR safe in the page service; shared account-policy currently blocks the anonymous HTTP crawler', async () => {
    const server = await start();
    const slug = 'honda-civic-2018-crlv-fixture-42';
    const response = await request(server).get(`/lote/${slug}`).set('User-Agent', 'WhatsApp');
    expect(response.status).toBe(401);
    expect(state.getLotCalls).toHaveLength(0);
    const plan = await context.runRead(() => app.get(PagesService).lot(slug, context.identity.ANONIMO, { protocol: 'https', host: 'fixture.test', userAgent: 'WhatsApp' }));
    expect(plan.status).toBeUndefined();
    expect(plan.headers['cache-control']).toBe('private, no-store');
    expect(plan.body).toContain('<title>Honda Civic 2018');
    expect(plan.body).toContain('window.__PUBLICO__=true');
    expect(plan.body).not.toContain('internal-timezone');
    expect(plan.body).not.toContain('internal-collection-secret');
    expect(plan.body).not.toContain('raw-private-document-secret');
    expect(state.getLotCalls[0]).toMatchObject({ id: 42, options: { interno: false } });
    expect(state.queries).toHaveLength(0);
  });

  it('rejects noncanonical lot slugs and keeps logged-in data projection public-safe', async () => {
    const server = await start();
    const mismatch = await request(server).get('/lote/another-name-42').set('Cookie', cookie);
    expect(mismatch.status).toBe(404);
    expect(mismatch.body).toEqual({ erro: 'Lote não encontrado.' });
    const response = await request(server).get('/lote/honda-civic-2018-crlv-fixture-42').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('raw-private-document-secret');
    expect(state.getLotCalls.at(-1).options.interno).toBe(false);
  });

  it('serves robots, landing-only sitemap, and the legacy missing-certificate envelope', async () => {
    const server = await start();
    const robots = await request(server).get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers['content-type']).toContain('text/plain');
    expect(robots.text).toContain('Allow: /api/img');
    expect(robots.text).toContain('Sitemap: https://radar.example/sitemap.xml');
    const sitemap = await request(server).get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toContain('application/xml');
    expect(sitemap.text).toContain('<loc>https://radar.example/</loc>');
    expect(sitemap.text).not.toContain('/lote/');
    const cert = await request(server).get('/ca.crt');
    expect(cert.status).toBe(404);
    expect(cert.body).toEqual({ erro: 'CA não gerada' });
  });

  it('masks lot repository failures and does not expose raw exception text', async () => {
    const server = await start({ lotFailure: true });
    const response = await request(server).get('/lote/honda-civic-2018-crlv-fixture-42').set('Cookie', cookie).set('Accept', 'application/json');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ erro: 'erro interno' });
    expect(JSON.stringify(response.body)).not.toContain('private db failure');
  });
});
