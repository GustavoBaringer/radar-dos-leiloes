import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import net from 'node:net';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { load } from 'cheerio';

const FIXTURE = {
  db: 'postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma', redis: 'redis://127.0.0.1:56380',
  issuer: 'http://127.0.0.1:58081/realms/radar-migration-test', clientId: 'radar-test-web',
  clientSecret: 'radar-test-client-secret', sessionSecret: 'radar-migration-fixture-cookie-secret-not-for-production',
  user: { username: 'radar-user-test', password: 'radar-user-password', role: 'comum' },
};
const APP_ORIGIN = 'http://127.0.0.1:45450';
const IDP_ORIGIN = 'http://127.0.0.1:58081';
const REALM_PATH = '/realms/radar-migration-test';

Object.assign(process.env, {
  NODE_ENV: 'test', BIND_HOST: '127.0.0.1', PORT: '45450', SITE_URL: APP_ORIGIN,
  DATABASE_URL: FIXTURE.db, REDIS_URL: FIXTURE.redis, OIDC_ISSUER: FIXTURE.issuer,
  OIDC_CLIENT_ID: FIXTURE.clientId, OIDC_CLIENT_SECRET: FIXTURE.clientSecret, OIDC_ROLE_ADMIN: 'radar-admin',
  APP_SESSAO_SEGREDO: FIXTURE.sessionSecret, ANTIBOT_MODE: 'off', ANTIBOT_CHALLENGE_MODE: 'off',
});

function requireFixtureUrl(value, origin, pathPrefix) {
  const url = new URL(value);
  if (url.origin !== origin || !url.pathname.startsWith(pathPrefix)) throw new Error('PKCE test refused a non-fixture URL.');
  return url;
}
requireFixtureUrl(process.env.DATABASE_URL.replace('postgresql://radar_test:radar_test_local@127.0.0.1:55433', 'http://127.0.0.1:55433'), 'http://127.0.0.1:55433', '/radar_prisma');
requireFixtureUrl(process.env.REDIS_URL.replace('redis://', 'http://'), 'http://127.0.0.1:56380', '/');
requireFixtureUrl(process.env.OIDC_ISSUER, IDP_ORIGIN, REALM_PATH);

const tcpReady = port => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error(`Fixture 127.0.0.1:${port} unavailable`)); });
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', reject);
});
const assertPortFree = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
});

// Small test-only, host/path-scoped cookie jar. It never forwards cookies across origins.
class LoopbackCookieJar {
  cookies = [];
  absorb(response, requestUrl) {
    const url = new URL(requestUrl);
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map(part => part.trim());
      const equals = pair.indexOf('=');
      if (equals < 1) continue;
      const name = pair.slice(0, equals), value = pair.slice(equals + 1);
      const lower = attributes.map(attr => attr.toLowerCase());
      const pathAttr = attributes.find(attr => /^path=/i.test(attr));
      const path = pathAttr ? pathAttr.slice(pathAttr.indexOf('=') + 1) : '/';
      const domainAttr = attributes.find(attr => /^domain=/i.test(attr));
      const domain = domainAttr ? domainAttr.slice(domainAttr.indexOf('=') + 1).replace(/^\./, '').toLowerCase() : url.hostname.toLowerCase();
      const key = cookie => cookie.name === name && cookie.domain === domain && cookie.path === path;
      this.cookies = this.cookies.filter(cookie => !key(cookie));
      if (!lower.includes('max-age=0') && value !== '') this.cookies.push({ name, value, domain, path, secure: lower.includes('secure') });
    }
  }
  header(target) {
    const url = new URL(target);
    const loopbackSecureContext = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase());
    return this.cookies.filter(cookie => {
      const hostMatches = url.hostname.toLowerCase() === cookie.domain || url.hostname.toLowerCase().endsWith(`.${cookie.domain}`);
      return hostMatches && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
        && (!cookie.secure || url.protocol === 'https:' || loopbackSecureContext);
    }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  get(target, name) { return this.header(target).split('; ').map(part => part.split('=')).find(([key]) => key === name)?.[1]; }
}

// Import OIDC-sensitive server modules after fixture env is set.
const [{ createHttpDependencies }, oidc, authModule, accountsModule, catalogModule, platform, contextModule, authCore] = await Promise.all([
  import('../../../dist/src/bootstrap/http-dependencies.js'), import('../../../dist/src/infra/auth/oidc.adapter.js'),
  import('../../../dist/src/application/modules/auth/auth.module.js'), import('../../../dist/src/application/modules/accounts/accounts.module.js'),
  import('../../../dist/src/application/modules/catalog/catalog.module.js'), import('../../../dist/src/infra/http/http-platform.js'),
  import('../../../dist/src/application/modules/http-platform/http-platform.module.js'), import('../../../dist/src/infra/auth/session.js'),
]);

describe('real Keycloak Authorization Code + PKCE HTTP flow', () => {
  let app;
  let dependencies;
  let subjects = [];
  let priorUsers = new Map();
  let userFixture;

  async function authorizeThroughIdp() {
    const jar = new LoopbackCookieJar();
    const startUrl = new URL('/auth/login', APP_ORIGIN);
    startUrl.searchParams.set('de', '/alertas');
    const start = await fetch(startUrl, { redirect: 'manual' });
    jar.absorb(start, startUrl);
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.get('location'));
    requireFixtureUrl(authUrl, IDP_ORIGIN, `${REALM_PATH}/protocol/openid-connect/auth`);
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('client_id')).toBe(FIXTURE.clientId);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}/auth/callback`);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(jar.get(startUrl, 'radar_pkce')).toBeTruthy();

    async function idpRequest(initialUrl, init = {}) {
      let current = requireFixtureUrl(initialUrl, IDP_ORIGIN, REALM_PATH);
      for (let hop = 0; hop < 10; hop++) {
        const headers = new Headers(init.headers ?? {});
        const cookie = jar.header(current);
        if (cookie) headers.set('cookie', cookie);
        const response = await fetch(current, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        jar.absorb(response, current);
        if (response.status >= 300 && response.status < 400) {
          const target = new URL(response.headers.get('location'), current);
          if (target.origin === APP_ORIGIN && target.pathname === '/auth/callback') return { callbackUrl: target, jar };
          current = requireFixtureUrl(target, IDP_ORIGIN, REALM_PATH);
          init = { method: 'GET' };
          continue;
        }
        return { response, current, jar };
      }
      throw new Error('Keycloak auth form redirect limit exceeded.');
    }

    const loginPage = await idpRequest(authUrl);
    if (!loginPage.response?.ok) throw new Error(`Keycloak login form unavailable (${loginPage.response?.status ?? 'redirect'}).`);
    const html = await loginPage.response.text();
    const $ = load(html);
    let form;
    $('form').each((_, element) => {
      const candidate = $(element);
      if (candidate.find('input[name="username"]').length && candidate.find('input[name="password"]').length) form ??= candidate;
    });
    if (!form) throw new Error('Fixture Keycloak login form fields were not found.');
    const action = new URL(form.attr('action') ?? '', loginPage.current);
    requireFixtureUrl(action, IDP_ORIGIN, REALM_PATH);
    const fields = new URLSearchParams();
    form.find('input').each((_, element) => {
      const input = $(element), name = input.attr('name'), type = (input.attr('type') ?? 'text').toLowerCase();
      if (!name || ['checkbox', 'radio', 'button', 'file'].includes(type)) return;
      if (type === 'submit') { fields.set(name, input.attr('value') ?? ''); return; }
      if (name === 'username') fields.set(name, FIXTURE.user.username);
      else if (name === 'password') fields.set(name, FIXTURE.user.password);
      else fields.append(name, input.attr('value') ?? '');
    });
    form.find('button[name]').each((_, element) => { const button = $(element); fields.set(button.attr('name'), button.attr('value') ?? button.text().trim()); });
    if (!fields.has('username') || !fields.has('password')) throw new Error('Fixture login form fields were incomplete.');
    const posted = await idpRequest(action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields });
    if (!posted.callbackUrl) {
      const failedHtml = await posted.response.text();
      const diagnostic = load(failedHtml)('#kc-error-message, .alert-error, [role="alert"]').text().trim()
        .replaceAll(FIXTURE.user.username, '[fixture-user]').replaceAll(FIXTURE.user.password, '[redacted]').slice(0, 180);
      const cookieNames = jar.header(action).split('; ').filter(Boolean).map(pair => pair.split('=')[0]).join(',') || 'none';
      const storedCookies = jar.cookies.map(cookie => `${cookie.name}@${cookie.domain}${cookie.path}${cookie.secure ? ';secure' : ''}`).join(',') || 'none';
      throw new Error(`Keycloak did not redirect to the allowlisted callback (HTTP ${posted.response?.status ?? 'redirect'}${diagnostic ? `; ${diagnostic}` : ''}; cookies=${cookieNames}; stored=${storedCookies}; actionPath=${action.pathname}).`);
    }
    expect(posted.callbackUrl.searchParams.get('state')).toBe(state);
    expect(posted.callbackUrl.searchParams.get('code')).toBeTruthy();
    expect(posted.callbackUrl.searchParams.get('iss')).toBe(FIXTURE.issuer);
    expect(posted.callbackUrl.searchParams.get('session_state')).toBeTruthy();
    return { ...posted, state, callbackCookie: jar.header(posted.callbackUrl) };
  }

  beforeAll(async () => {
    await Promise.all([tcpReady(55433), tcpReady(56380), tcpReady(58081)]);
    await assertPortFree(45450); // Refuse to touch or terminate another process.
    const discoveryResponse = await fetch(`${FIXTURE.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5_000) });
    if (!discoveryResponse.ok || (await discoveryResponse.json()).issuer !== FIXTURE.issuer) throw new Error('Local Keycloak discovery/issuer verification failed.');

    dependencies = await createHttpDependencies(oidc);
    dependencies.data.ensureSources = async () => {};
    const db = await dependencies.data.query('SELECT current_database() AS name');
    if (db[0]?.name !== 'radar_prisma') throw new Error('Not connected to the isolated radar_prisma database.');

    const verified = await oidc.loginPorSenha(FIXTURE.user.username, FIXTURE.user.password);
    if (!verified?.sub || verified.papel !== FIXTURE.user.role) throw new Error('Fixture identity preflight failed.');
    userFixture = { ...FIXTURE.user, sub: verified.sub };
    subjects = [verified.sub];
    const before = await dependencies.data.query('SELECT id, sub, email, nome, papel, visto_em FROM users WHERE sub = ANY($1::text[])', [subjects]);
    priorUsers = new Map(before.map(row => [row.sub, row]));

    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/src/web`, appDist: `${process.cwd()}/app-busca/dist`, certDir: `${process.cwd()}/certs`, dataDir: `${process.cwd()}/data` };
    class PkceRealTestRoot {}
    Module({ imports: [contextModule.HttpPlatformModule.forRoot({ env: process.env, paths, dependencies }), authModule.AuthModule, accountsModule.AccountsModule, catalogModule.CatalogModule] })(PkceRealTestRoot);
    app = await NestFactory.create(PkceRealTestRoot, new FastifyAdapter(platform.radarHttpAdapterOptions(process.env)), { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    const context = app.get(contextModule.RADAR_HTTP_CONTEXT);
    await platform.configureHttpPlatform(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.listen(45450, '127.0.0.1');
  }, 100_000);

  afterAll(async () => {
    try {
      if (dependencies && subjects.length) {
        for (const sub of subjects) {
          const prior = priorUsers.get(sub);
          if (prior) await dependencies.data.query('UPDATE users SET email=$2, nome=$3, papel=$4, visto_em=$5 WHERE sub=$1', [sub, prior.email, prior.nome, prior.papel, prior.visto_em]);
          else await dependencies.data.query('DELETE FROM users WHERE sub=$1', [sub]);
        }
        const restored = await dependencies.data.query('SELECT id, sub, email, nome, papel, visto_em FROM users WHERE sub = ANY($1::text[])', [subjects]);
        for (const sub of subjects) {
          const prior = priorUsers.get(sub), row = restored.find(user => user.sub === sub);
          if (!prior) expect(row).toBeUndefined(); else expect(row).toEqual(prior);
        }
      }
    } finally {
      const current = app;
      app = undefined;
      if (current) await current.close(); else await dependencies?.runtime.close();
    }
  }, 30_000);

  it('completes actual IdP browser-form HTTP authorization code + PKCE, callback, signed session and /api/me', async () => {
    const flow = await authorizeThroughIdp();
    const callback = await fetch(flow.callbackUrl, { redirect: 'manual', headers: { cookie: flow.callbackCookie }, signal: AbortSignal.timeout(15_000) });
    flow.jar.absorb(callback, flow.callbackUrl);
    if (callback.status !== 302) {
      const callbackHtml = await callback.text();
      let diagnostic = load(callbackHtml)('.erro').text().trim();
      if (!diagnostic && callback.headers.get('content-type')?.includes('application/json')) {
        try {
          const body = JSON.parse(callbackHtml);
          diagnostic = Array.isArray(body.message) ? body.message.join('; ') : String(body.error ?? body.erro ?? Object.keys(body).join(','));
        } catch { /* Don't include arbitrary response content in test output. */ }
      }
      diagnostic = diagnostic
        .replaceAll(FIXTURE.user.username, '[fixture-user]').replaceAll(FIXTURE.user.password, '[redacted]')
        .replaceAll(flow.callbackUrl.searchParams.get('code'), '[code]').replaceAll(flow.state, '[state]').slice(0, 220);
      const queryKeys = [...flow.callbackUrl.searchParams.keys()].join(',');
      throw new Error(`Native callback rejected the real PKCE response (${callback.status}, ${callback.headers.get('content-type') ?? 'no content type'}${diagnostic ? `; ${diagnostic}` : ''}; callbackKeys=${queryKeys}).`);
    }
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/alertas');
    const nativeCookies = flow.jar.header(`${APP_ORIGIN}/api/me`);
    const token = flow.jar.get(`${APP_ORIGIN}/api/me`, 'radar_sessao');
    expect(authCore.lerToken(token)).toMatchObject({ valido: true, papel: 'comum', sub: userFixture.sub });
    expect(callback.headers.getSetCookie().some(value => value.startsWith('radar_pkce=;'))).toBe(true);
    const me = await fetch(`${APP_ORIGIN}/api/me`, { headers: { cookie: nativeCookies }, signal: AbortSignal.timeout(15_000) });
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toContain('no-store');
    const payload = await me.json();
    expect(payload).toMatchObject({ oidc: true, papel: 'comum', logado: true, conta: { email: 'user@example.test', porProvedor: true } });
    const rows = await dependencies.data.query('SELECT id, sub, email, nome, papel FROM users WHERE sub=$1', [userFixture.sub]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sub: userFixture.sub, papel: 'comum', email: 'user@example.test', nome: 'Fixture User' });
    expect(Number(rows[0].id)).toBe(payload.conta.id);

    // Replay the same actual code with the actual original PKCE cookie: provider must reject consumed code.
    const replay = await fetch(flow.callbackUrl, { redirect: 'manual', headers: { cookie: flow.callbackCookie }, signal: AbortSignal.timeout(15_000) });
    expect(replay.status).toBe(400);
    const afterReplay = await dependencies.data.query('SELECT id, sub, papel FROM users WHERE sub=$1', [userFixture.sub]);
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]).toMatchObject({ id: rows[0].id, sub: userFixture.sub, papel: 'comum' });
  }, 100_000);

  it('rejects a callback with tampered state before identity upsert', async () => {
    const flow = await authorizeThroughIdp();
    // Keep only OIDC's code/state inputs so this negative case reaches the existing PKCE guard.
    const tampered = new URL('/auth/callback', APP_ORIGIN);
    tampered.searchParams.set('code', flow.callbackUrl.searchParams.get('code'));
    tampered.searchParams.set('state', 'wrong-state');
    const before = await dependencies.data.query('SELECT id, sub, email, nome, papel FROM users WHERE sub=$1', [userFixture.sub]);
    const response = await fetch(tampered, { redirect: 'manual', headers: { cookie: flow.callbackCookie }, signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(400);
    expect((await response.text()).toLowerCase()).toContain('state divergente');
    expect(await dependencies.data.query('SELECT id, sub, email, nome, papel FROM users WHERE sub=$1', [userFixture.sub])).toEqual(before);
  }, 100_000);

  it('rejects a mismatched issuer from an actual provider callback before token exchange or identity upsert', async () => {
    const flow = await authorizeThroughIdp();
    const before = await dependencies.data.query('SELECT id, sub, email, nome, papel FROM users WHERE sub=$1', [userFixture.sub]);
    const mismatched = new URL(flow.callbackUrl);
    mismatched.searchParams.set('iss', 'http://127.0.0.1:58081/realms/not-the-fixture');
    const response = await fetch(mismatched, { redirect: 'manual', headers: { cookie: flow.callbackCookie }, signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(400);
    expect((await response.text())).toContain('Issuer do provedor inválido.');
    expect(await dependencies.data.query('SELECT id, sub, email, nome, papel FROM users WHERE sub=$1', [userFixture.sub])).toEqual(before);
  }, 100_000);
});
