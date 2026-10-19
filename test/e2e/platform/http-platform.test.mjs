import { afterEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { Controller, Get, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { dependencies } from '../../../scripts/fixtures/host-fixture.mjs';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { RadarHttpContext } from '../../../dist/src/infra/http/radar-http-context.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { criarToken } from '../../../dist/src/infra/auth/session.js';

class TestController {
  catalog() { return { private: true }; }
  boom() { throw new Error('database credential leaked'); }
  form(req) { return { value: req.body.value }; }
}
Controller()(TestController);
Get('api/catalog')(TestController.prototype, 'catalog', Object.getOwnPropertyDescriptor(TestController.prototype, 'catalog'));
Get('api/boom')(TestController.prototype, 'boom', Object.getOwnPropertyDescriptor(TestController.prototype, 'boom'));
Post('api/form')(TestController.prototype, 'form', Object.getOwnPropertyDescriptor(TestController.prototype, 'form'));
Req()(TestController.prototype, 'form', 0);

describe('native HTTP platform', () => {
  let app;
  let context;
  let state;

  async function start(options = {}) {
    const fixture = dependencies(options);
    state = fixture.state;
    const env = { NODE_ENV: 'test' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: `${process.cwd()}/app-busca/dist`, certDir: `${process.cwd()}/certs`, dataDir: `${process.cwd()}/data` };
    class PlatformTestModule {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps })], controllers: [TestController] })(PlatformTestModule);
    app = await NestFactory.create(PlatformTestModule, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    context = app.get(RADAR_HTTP_CONTEXT);
    await configureHttpPlatform(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }

  afterEach(async () => { await app?.close(); app = undefined; });

  it('denies anonymous catalog requests, masks server errors, sets no-store/security headers, and parses forms', async () => {
    const server = await start();
    const denied = await request(server).get('/api/catalog');
    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toContain('no-store');
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
    const session = `radar_sessao=${criarToken('admin', 'fixture-sub')}`;
    const failure = await request(server).get('/api/boom').set('Cookie', session);
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ erro: 'erro interno' });
    expect(JSON.stringify(failure.body)).not.toContain('database credential');
    expect((await request(server).post('/api/form').set('Cookie', session).type('form').send({ value: 'ok' })).body).toEqual({ value: 'ok' });
    const missing = await request(server).get('/api/missing').set('Cookie', session);
    expect(missing.status).toBe(404);
    expect(missing.body.erro).toBeDefined();
  });

  it('returns 401 when the cookie identity was deleted', async () => {
    const server = await start({ identityDeleted: true });
    const cookie = criarToken('admin', 'deleted-sub');
    const response = await request(server).get('/api/catalog').set('Cookie', `radar_sessao=${cookie}`);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('rejects request bodies over 16 KiB', async () => {
    const server = await start();
    const response = await request(server).post('/api/form').set('Cookie', `radar_sessao=${criarToken('admin', 'fixture-sub')}`).set('content-type', 'application/json').send({ value: 'x'.repeat(17_000) });
    expect(response.status).toBe(413);
  });

  it('closes resources once, and closes after startup failure', async () => {
    await start();
    await app.close(); app = undefined;
    expect(state.closes).toBe(1);
    const fixture = dependencies({ startupFailure: true });
    const failedContext = new RadarHttpContext({ env: { NODE_ENV: 'test' }, paths: { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' }, dependencies: fixture.deps });
    await expect(failedContext.initialize()).rejects.toThrow('startup fixture');
    await failedContext.close();
    expect(fixture.state.closes).toBe(1);
  });
});
