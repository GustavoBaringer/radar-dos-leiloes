import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { accountDependencies } from './helpers/accounts-fixture.mjs';
import { AccountsModule } from '../../../dist/src/application/modules/accounts/accounts.module.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { criarToken } from '../../../dist/src/infra/auth/session.js';

jest.setTimeout(30_000);

describe('accounts HTTP module', () => {
  let app;
  let state;
  async function start({ throttleCount = 1 } = {}) {
    const fixture = accountDependencies({ throttleCount });
    state = fixture.state;
    const env = { NODE_ENV: 'test', ANTIBOT_MODE: 'off' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class AccountsTestRoot {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), AccountsModule] })(AccountsTestRoot);
    app = await NestFactory.create(AccountsTestRoot, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    await configureHttpPlatform(app, app.get(RADAR_HTTP_CONTEXT));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  const cookie = (sub = 'user-one', papel = 'admin') => `radar_sessao=${criarToken(papel, sub)}`;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('rejects anonymous /me without querying account data', async () => {
    const server = await start();
    const response = await request(server).get('/api/me');
    expect(response.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });

  it('serves /me without cache and derives role from server identity; HEAD remains empty', async () => {
    const server = await start();
    const response = await request(server).get('/api/me').set('Cookie', cookie('user-two', 'admin'));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.papel).toBe('comum');
    expect(response.body.conta.id).toBe(22);
    const head = await request(server).head('/api/me').set('Cookie', cookie());
    expect(head.status).toBe(200);
    expect(head.text ?? '').toBe('');
  });

  it('scopes favorite mutations and alert reads to the authenticated identity', async () => {
    const server = await start();
    const mutation = await request(server).post('/api/favorites').set('Cookie', cookie('user-two')).send({ lotId: 7 });
    expect(mutation.status).toBe(201);
    expect(state.writes[0].params).toEqual([22, 7]);
    const alerts = await request(server).get('/api/alerts?page=2&pageSize=5').set('Cookie', cookie('user-one'));
    expect(alerts.status).toBe(200);
    expect(state.queries.some(({ params }) => params[0] === 11)).toBe(true);
  });

  it('rejects malformed and unknown favorite fields before any query', async () => {
    const server = await start();
    const response = await request(server).post('/api/favorites').set('Cookie', cookie()).send({ lotId: 3, ownerId: 22 });
    expect(response.status).toBe(400);
    expect(state.queries).toHaveLength(0);
  });

  it.each([{}, { expirationTime: null }, { expirationTime: 123 }])('accepts browser push expiration shape %j', async shape => {
    const server = await start();
    // The endpoint is valid; malformed absent keys should be rejected by service only if this fixture's required payload is missing.
    const response = await request(server).post('/api/push/subscribe').set('Cookie', cookie()).send({ endpoint: 'https://push.example/sub', keys: { p256dh: 'YQ==', auth: 'Yg==' }, ...shape });
    expect(response.status).toBe(201);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].params[4]).toBe(11);
  });

  it.each([{ expirationTime: '123' }, { expirationTime: -1 }, { expirationTime: 4, extra: true }])('rejects invalid push payload %j before SQL', async shape => {
    const server = await start();
    const response = await request(server).post('/api/push/subscribe').set('Cookie', cookie()).send({ endpoint: 'https://push.example/sub', keys: { p256dh: 'YQ==', auth: 'Yg==' }, ...shape });
    expect(response.status).toBe(400);
    expect(state.queries).toHaveLength(0);
  });

  it('returns signup field errors and throttles without touching database', async () => {
    const server = await start({ throttleCount: [1, 11] });
    const invalid = await request(server).post('/api/cadastro').send({ nome: 'X' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ erro: 'Informe seu nome completo.', campo: 'nome' });
    const limited = await request(server).post('/api/cadastro').send({ nome: 'Pessoa Exemplo' });
    expect(limited.status).toBe(429);
    expect(state.queries).toHaveLength(0);
  });
});
