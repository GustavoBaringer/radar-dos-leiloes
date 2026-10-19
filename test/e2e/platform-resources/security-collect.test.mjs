import { afterEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { dependencies } from '../../../scripts/fixtures/host-fixture.mjs';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { PlatformModule } from '../../../dist/src/application/modules/platform/platform.module.js';
import { criarToken } from '../../../dist/src/infra/auth/session.js';

describe('native security and collection endpoints', () => {
  let app;
  let state;
  let additions;
  async function start() {
    const fixture = dependencies();
    state = fixture.state;
    additions = [];
    fixture.deps.jobs.connectors = [{ def: { id: 'fixture-source' } }];
    fixture.deps.jobs.createCollectQueue = () => { state.queueCreated++; return { add: async (...args) => { additions.push(args); return { id: `job-${additions.length}` }; }, close: async () => { state.queueClosed++; } }; };
    const env = { NODE_ENV: 'test' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class AppModule {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), PlatformModule] })(AppModule);
    app = await NestFactory.create(AppModule, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false, abortOnError: false });
    const context = app.get(RADAR_HTTP_CONTEXT);
    await configureHttpPlatform(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  afterEach(async () => { await app?.close(); app = undefined; });

  it('serves shared challenge client config and admin-only bounded metrics without cache', async () => {
    const server = await start();
    const config = await request(server).get('/api/security-config');
    expect(config.status).toBe(200);
    expect(config.headers['cache-control']).toContain('no-store');
    expect(config.body).toEqual({ enabled: false, siteKey: null, actions: ['login', 'cadastro', 'espera'] });
    expect((await request(server).get('/api/security/metrics')).body).toEqual({ error: 'unauthorized' });
    const common = `radar_sessao=${criarToken('comum')}`;
    expect((await request(server).get('/api/security/metrics').set('Cookie', common)).body).toEqual({ error: 'forbidden' });
    const admin = `radar_sessao=${criarToken('admin', 'fixture-sub')}`;
    const metrics = await request(server).get('/api/security/metrics').set('Cookie', admin);
    expect(metrics.status).toBe(200);
    expect(metrics.headers['cache-control']).toContain('no-store');
    expect(metrics.body).toHaveProperty('modes.antibot', 'off');
    expect(metrics.body.images).toHaveProperty('total.requests', 0);
  });

  it('rejects unauthorized and invalid collection requests before queue effects, then enqueues admin job', async () => {
    const server = await start();
    expect((await request(server).post('/api/collect').send({ sourceId: 'fixture-source' })).status).toBe(401);
    const common = `radar_sessao=${criarToken('comum')}`;
    expect((await request(server).post('/api/collect').set('Cookie', common).send({ sourceId: 'fixture-source' })).status).toBe(403);
    const admin = `radar_sessao=${criarToken('admin', 'fixture-sub')}`;
    expect((await request(server).post('/api/collect').set('Cookie', admin).send({ sourceId: 'unknown' })).status).toBe(400);
    expect((await request(server).post('/api/collect').set('Cookie', admin).send({ sourceId: 'fixture-source', limit: 0 })).status).toBe(400);
    expect(additions).toHaveLength(0);
    const result = await request(server).post('/api/collect').set('Cookie', admin).send({ sourceId: 'fixture-source', limit: 25 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ enfileirado: [{ sourceId: 'fixture-source', jobId: 'job-1' }] });
    expect(additions).toEqual([['collect:manual', { sourceId: 'fixture-source', limit: 25 }]]);
    expect(state.queueCreated).toBe(1);
  });
});
