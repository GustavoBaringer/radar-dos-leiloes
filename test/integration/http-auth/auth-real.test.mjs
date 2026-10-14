import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import net from 'node:net';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';

const FIXTURE = {
  db: 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma',
  redis: 'redis://127.0.0.1:56380',
  issuer: 'http://127.0.0.1:58081/realms/radar-migration-test',
  clientId: 'radar-test-web',
  clientSecret: 'radar-test-client-secret',
  sessionSecret: 'radar-migration-fixture-cookie-secret-not-for-production',
  users: [
    { username: 'radar-admin-test', password: 'radar-test-password', role: 'admin' },
    { username: 'radar-user-test', password: 'radar-user-password', role: 'comum' },
  ],
};

Object.assign(process.env, {
  NODE_ENV: 'test', BIND_HOST: '127.0.0.1', PORT: '45450', SITE_URL: 'http://127.0.0.1:45450',
  DATABASE_URL: FIXTURE.db, REDIS_URL: FIXTURE.redis, OIDC_ISSUER: FIXTURE.issuer,
  OIDC_CLIENT_ID: FIXTURE.clientId, OIDC_CLIENT_SECRET: FIXTURE.clientSecret,
  OIDC_ROLE_ADMIN: 'radar-admin', APP_SESSAO_SEGREDO: FIXTURE.sessionSecret,
  ANTIBOT_MODE: 'off', ANTIBOT_CHALLENGE_MODE: 'off',
});

const assertLoopbackUrl = (value, expectedPort, pathname) => {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.port !== String(expectedPort) || (pathname && url.pathname !== pathname)) {
    throw new Error('Auth real integration refuses non-fixture network targets.');
  }
  return url;
};
assertLoopbackUrl(process.env.DATABASE_URL, 55433, '/radar_prisma');
assertLoopbackUrl(process.env.REDIS_URL, 56380);
assertLoopbackUrl(process.env.OIDC_ISSUER, 58081, '/realms/radar-migration-test');

const listenLoopback = (port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error(`Fixture 127.0.0.1:${port} unavailable`)); });
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', reject);
});

// Load environment-sensitive app modules only after the isolated values above are installed.
const [{ createHttpDependencies }, oidc, authModule, accountsModule, catalogModule, platform, contextModule, authCore] = await Promise.all([
  import('../../../dist/src/bootstrap/http-dependencies.js'),
  import('../../../dist/src/core/oidc.js'),
  import('../../../dist/src/application/modules/auth/auth.module.js'),
  import('../../../dist/src/application/modules/accounts/accounts.module.js'),
  import('../../../dist/src/application/modules/catalog/catalog.module.js'),
  import('../../../dist/src/infra/http/http-platform.js'),
  import('../../../dist/src/application/modules/http-platform/http-platform.module.js'),
  import('../../../dist/src/core/auth.js'),
]);

describe('real OIDC + PostgreSQL account HTTP integration', () => {
  let app;
  let context;
  let dependencies;
  let subjects = [];
  let previousUsers = new Map();

  async function userRows(subs) {
    return dependencies.data.query('SELECT id, sub, email, nome, papel, visto_em FROM users WHERE sub = ANY($1::text[])', [subs]);
  }

  beforeAll(async () => {
    await Promise.all([listenLoopback(55433), listenLoopback(56380), listenLoopback(58081)]);
    const discoveryResponse = await fetch(`${FIXTURE.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5_000) });
    if (!discoveryResponse.ok) throw new Error(`Local Keycloak discovery unavailable (${discoveryResponse.status}).`);
    const discovery = await discoveryResponse.json();
    if (discovery.issuer !== FIXTURE.issuer) throw new Error('Local Keycloak issuer mismatch; refusing real-auth integration.');

    dependencies = await createHttpDependencies(oidc);
    // Avoid source bootstrap/collection writes; identity, DB query, Redis and OIDC remain real.
    dependencies.data.ensureSources = async () => {};
    const dbRows = await dependencies.data.query('SELECT current_database() AS name');
    if (dbRows[0]?.name !== 'radar_prisma') throw new Error('Connected database is not the isolated radar_prisma fixture.');

    const verified = [];
    for (const fixtureUser of FIXTURE.users) {
      const identity = await oidc.loginPorSenha(fixtureUser.username, fixtureUser.password);
      if (!identity?.sub || identity.papel !== fixtureUser.role) throw new Error(`Real fixture token role verification failed for ${fixtureUser.username}.`);
      verified.push({ ...fixtureUser, sub: identity.sub });
    }
    subjects = verified.map(user => user.sub);
    const existing = await userRows(subjects);
    previousUsers = new Map(existing.map(row => [row.sub, row]));

    const paths = {
      projectRoot: process.cwd(), webRoot: `${process.cwd()}/src/web`, appDist: `${process.cwd()}/app-busca/dist`,
      certDir: `${process.cwd()}/certs`, dataDir: `${process.cwd()}/data`,
    };
    class AuthRealTestRoot {}
    Module({ imports: [contextModule.HttpPlatformModule.forRoot({ env: process.env, paths, dependencies }), authModule.AuthModule, accountsModule.AccountsModule, catalogModule.CatalogModule] })(AuthRealTestRoot);
    app = await NestFactory.create(AuthRealTestRoot, new FastifyAdapter(platform.radarHttpAdapterOptions(process.env)), { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    context = app.get(contextModule.RADAR_HTTP_CONTEXT);
    await platform.configureHttpPlatform(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 100_000);

  afterAll(async () => {
    try {
      if (dependencies && subjects.length) {
        // Preserve pre-existing fixture identities exactly; delete only identities this suite introduced.
        for (const sub of subjects) {
          const prior = previousUsers.get(sub);
          if (prior) {
            await dependencies.data.query('UPDATE users SET email=$2, nome=$3, papel=$4, visto_em=$5 WHERE sub=$1',
              [sub, prior.email, prior.nome, prior.papel, prior.visto_em]);
          } else {
            await dependencies.data.query('DELETE FROM users WHERE sub=$1', [sub]);
          }
        }
        const restored = await userRows(subjects);
        for (const sub of subjects) {
          const prior = previousUsers.get(sub);
          const row = restored.find(user => user.sub === sub);
          if (!prior) expect(row).toBeUndefined();
          else expect(row).toEqual(prior);
        }
      }
    } finally {
      const current = app;
      app = undefined;
      if (current) await current.close();
      else await dependencies?.runtime.close();
    }
  }, 30_000);

  const cookieFor = async (fixtureUser) => {
    const response = await request(app.getHttpServer()).post('/api/login').send({ usuario: fixtureUser.username, senha: fixtureUser.password, de: '/busca' });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/busca');
    const setCookie = response.headers['set-cookie']?.find(value => value.startsWith('radar_sessao='));
    expect(setCookie).toBeDefined();
    const token = setCookie.match(/radar_sessao=([^;]+)/)?.[1];
    expect(authCore.lerToken(token)).toMatchObject({ valido: true, papel: fixtureUser.role, sub: fixtureUser.sub });
    return setCookie.split(';')[0];
  };

  it('wrong password returns generic 401 and never upserts an identity', async () => {
    const before = await userRows(subjects);
    const response = await request(app.getHttpServer()).post('/api/login').send({ usuario: FIXTURE.users[1].username, senha: 'not-the-fixture-password' });
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Usuário ou senha incorretos.');
    expect(await userRows(subjects)).toEqual(before);
  }, 40_000);

  it('verified common-user grant creates/resolves the real DB identity and /api/me returns account data', async () => {
    const fixtureUser = { ...FIXTURE.users[1], sub: subjects[1] };
    const cookie = await cookieFor(fixtureUser);
    const [persisted] = await userRows([fixtureUser.sub]);
    expect(persisted).toMatchObject({ sub: fixtureUser.sub, papel: 'comum', email: 'user@example.test', nome: 'Fixture User' });
    expect(Number(persisted.id)).toBeGreaterThan(0);
    const me = await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toContain('no-store');
    expect(me.body).toMatchObject({ oidc: true, papel: 'comum', logado: true, conta: { id: Number(persisted.id), email: 'user@example.test', porProvedor: true } });
    const denied = await request(app.getHttpServer()).get('/api/stats').set('Cookie', cookie);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ erro: 'requer administrador' });
  }, 60_000);

  it('verified admin grant persists server-derived role and authorizes native catalog stats', async () => {
    const fixtureUser = { ...FIXTURE.users[0], sub: subjects[0] };
    const cookie = await cookieFor(fixtureUser);
    const [persisted] = await userRows([fixtureUser.sub]);
    expect(persisted).toMatchObject({ sub: fixtureUser.sub, papel: 'admin', email: 'admin@example.test', nome: 'Fixture Admin' });
    const stats = await request(app.getHttpServer()).get('/api/stats').set('Cookie', cookie);
    expect(stats.status).toBe(200);
    expect(stats.body).toHaveProperty('totals');
  }, 60_000);

  it('rejects client-supplied role before any OIDC account upsert', async () => {
    const before = await userRows(subjects);
    const response = await request(app.getHttpServer()).post('/api/login').send({
      usuario: FIXTURE.users[1].username, senha: FIXTURE.users[1].password, papel: 'admin',
    });
    expect(response.status).toBe(400);
    expect(await userRows(subjects)).toEqual(before);
  }, 40_000);
});
