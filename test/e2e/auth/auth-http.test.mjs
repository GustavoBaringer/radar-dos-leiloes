import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { authDependencies } from './helpers/auth-fixture.mjs';
import { AuthModule } from '../../../dist/src/application/modules/auth/auth.module.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { lerToken } from '../../../dist/src/infra/auth/session.js';

jest.setTimeout(30_000);

describe('auth HTTP module', () => {
  let app;
  let state;
  async function start(options = {}) {
    const fixture = authDependencies(options);
    state = fixture.state;
    const env = { NODE_ENV: 'test', ANTIBOT_MODE: 'off', OIDC_ISSUER: 'https://idp.test/realms/fixture' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class AuthTestRoot {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), AuthModule] })(AuthTestRoot);
    app = await NestFactory.create(AuthTestRoot, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await configureHttpPlatform(app, app.get(RADAR_HTTP_CONTEXT));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  afterEach(async () => { await app?.close(); app = undefined; });

  it('serves the extracted login template with a safe internal destination', async () => {
    const server = await start();
    const response = await request(server).get('/login?de=https%3A%2F%2Fevil.example%2Fsteal');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('<title>Entrar · Radar de Leilões</title>');
    expect(response.text).not.toContain('https://evil.example/steal');
    expect(response.text).toContain('/busca');
  });

  it('returns the same generic wrong-password HTML and does not upsert identity', async () => {
    const server = await start();
    const response = await request(server).post('/api/login').send({ usuario: 'unknown', senha: 'wrong', de: '/alertas' });
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Usuário ou senha incorretos.');
    expect(state.identities).toHaveLength(0);
  });

  it('accepts JSON and form login and sets a signed HttpOnly session from verified provider identity', async () => {
    const server = await start();
    const response = await request(server).post('/api/login').send({ usuario: 'valid-user', senha: 'valid-password', de: '/alertas' });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/alertas');
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    const token = cookie.match(/radar_sessao=([^;]+)/)?.[1];
    expect(lerToken(token)).toMatchObject({ valido: true, papel: 'admin', sub: 'verified-sub' });
    expect(state.identities).toEqual([{ sub: 'verified-sub', email: 'verified@example.test', nome: 'Verified User', papel: 'admin' }]);
    const form = await request(server).post('/api/login').type('form').send({ usuario: 'valid-user', senha: 'valid-password' });
    expect(form.status).toBe(302);
    expect(form.headers.location).toBe('/busca');
  });

  it('starts OIDC with safe callback destination, state/PKCE cookie, trusted origin and Secure flag', async () => {
    const server = await start();
    const response = await request(server).get('/auth/login?de=https%3A%2F%2Fevil.example').set('Host', 'trusted.example').set('X-Forwarded-Proto', 'https');
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('https://idp.test/authorize');
    expect(response.headers['set-cookie'][0]).toContain('radar_pkce=fixture-pkce-cookie');
    expect(response.headers['set-cookie'][0]).toContain('Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600');
    expect(state.startCalls).toEqual([{ redirectUri: 'https://trusted.example/auth/callback', destino: '/busca' }]);
  });

  it('rejects provider cancellation and invalid state without identity upsert', async () => {
    const server = await start();
    const cancelled = await request(server).get('/auth/callback?error=access_denied');
    expect(cancelled.status).toBe(400);
    const escaped = await request(server).get('/auth/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(escaped.text).toContain('&lt;script&gt;');
    expect(escaped.text).not.toContain('<script>alert(1)</script>');
    const invalid = await request(server).get('/auth/callback?code=valid-code&state=wrong').set('Cookie', 'radar_pkce=fixture-pkce-cookie');
    expect(invalid.status).toBe(400);
    expect(state.identities).toHaveLength(0);
  });

  it('applies the 8-attempt Redis login budget before contacting the identity provider', async () => {
    const server = await start({ attempts: 8 });
    const response = await request(server).post('/api/login').send({ usuario: 'valid-user', senha: 'valid-password' });
    expect(response.status).toBe(429);
    expect(response.text).toContain('Muitas tentativas. Aguarde 15 minutos.');
    expect(state.passwordCalls).toHaveLength(0);
    expect(state.identities).toHaveLength(0);
  });

  it('completes provider callback, sets all session cookies and redirects only to safe destination', async () => {
    const server = await start();
    const started = await request(server).get('/auth/login?de=%2Falertas');
    expect(started.status).toBe(302);
    const callback = await request(server).get('/auth/callback?code=valid-code&state=fixture-state&session_state=fixture-session&iss=https%3A%2F%2Fidp.test%2Frealms%2Ffixture').set('Cookie', 'radar_pkce=fixture-pkce-cookie').set('X-Forwarded-Proto', 'https');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/alertas');
    expect(callback.headers['set-cookie']).toHaveLength(3);
    expect(callback.headers['set-cookie'][0]).toContain('Secure');
    expect(callback.headers['set-cookie'][1]).toContain('radar_pkce=; Path=/auth; Max-Age=0');
    expect(callback.headers['set-cookie'][2]).toContain('radar_oidc=1');
    expect(lerToken(callback.headers['set-cookie'][0].match(/radar_sessao=([^;]+)/)?.[1])).toMatchObject({ sub: 'verified-sub', papel: 'admin' });
  });

  it('accepts only bounded provider callback metadata and rejects unknown, repeated, or mismatched issuer values before OIDC exchange', async () => {
    const server = await start();
    const cookie = 'radar_pkce=fixture-pkce-cookie';
    const unknown = await request(server).get('/auth/callback?code=valid-code&state=fixture-state&extra=ignored').set('Cookie', cookie);
    expect(unknown.status).toBe(400);
    const repeated = await request(server).get('/auth/callback?code=valid-code&state=fixture-state&iss=https%3A%2F%2Fidp.test%2Frealms%2Ffixture&iss=https%3A%2F%2Fevil.test').set('Cookie', cookie);
    expect(repeated.status).toBe(400);
    const wrongIssuer = await request(server).get('/auth/callback?code=valid-code&state=fixture-state&iss=https%3A%2F%2Fevil.test').set('Cookie', cookie);
    expect(wrongIssuer.status).toBe(400);
    expect(wrongIssuer.text).toContain('Issuer do provedor inválido.');
    expect(state.callbackCalls).toHaveLength(0);
    expect(state.identities).toHaveLength(0);
  });

  it('clears local cookies and performs provider logout only for OIDC sessions', async () => {
    const server = await start();
    const local = await request(server).get('/auth/logout').set('Cookie', 'radar_sessao=old');
    expect(local.status).toBe(302);
    expect(local.headers.location).toBe('/login');
    expect(local.headers['set-cookie']).toHaveLength(2);
    const remote = await request(server).get('/auth/logout').set('Host', 'trusted.example').set('Cookie', 'radar_sessao=old; radar_oidc=1');
    expect(remote.headers.location).toContain('https://idp.test/logout');
    expect(state.logoutCalls).toEqual(['http://trusted.example/login']);
  });
});
