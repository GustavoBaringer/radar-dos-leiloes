import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = process.env.HOST_VARIANT === 'compiled';
const entry = compiled ? 'dist/src' : 'src';
const [{ createLegacyHost }, auth, pathsModule] = await Promise.all([
  import(pathToFileURL(resolve(root, entry, `legacy-host.${compiled ? 'js' : 'ts'}`)).href),
  import(pathToFileURL(resolve(root, entry, `core/auth.${compiled ? 'js' : 'ts'}`)).href),
  import(pathToFileURL(resolve(root, entry, `bootstrap/paths.${compiled ? 'js' : 'ts'}`)).href),
]);
const paths = pathsModule.resolveHttpPaths(pathToFileURL(resolve(root, entry, `server.${compiled ? 'js' : 'ts'}`)).href);
assert.ok(existsSync(resolve(paths.webRoot, 'landing-antibot.html')), `missing fixture assets at ${paths.webRoot}`);
assert.equal(paths.projectRoot, root);
process.chdir('/');

const BRANDS_SQL = 'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC';
const PHOTO_HOSTS_SQL = /SELECT split_part\(split_part\(p, ':/;

function dependencies({ queryFailure = false, identityDeleted = false, startupFailure = false, mode = 'off', injectDriver = true } = {}) {
  const state = { queries: [], init: 0, closes: 0, queueClosed: 0, ensured: 0, redis: 0, connected: 0, subscribed: 0, queueCreated: 0, driverChecks: [], identityLookups: 0, antibotUrl: '', wsUrl: '', antibotRedisConnected: 0, antibotRedisClosed: 0, protectionClosed: 0 };
  const deps = {
    data: {
      query: async (sql) => {
        state.queries.push(sql);
        if (sql === BRANDS_SQL) {
          if (queryFailure && state.queries.filter((seen) => seen === BRANDS_SQL).length === 1) throw new Error('db secret detail');
          return [{ brand: 'FORD', count: 2 }];
        }
        if (PHOTO_HOSTS_SQL.test(sql)) return [];
        throw new Error(`unexpected SQL in host test: ${sql}`);
      },
      searchLots: async () => { throw Error('unexpected searchLots'); },
      searchLotsMapa: async () => { throw Error('unexpected searchLotsMapa'); },
      getLot: async () => { throw Error('unexpected getLot'); },
      getStats: async () => { throw Error('unexpected getStats'); },
      ensureSources: async () => { state.ensured++; if (startupFailure) throw Error('startup fixture'); },
      contarCasaveis: async () => { throw Error('unexpected contarCasaveis'); },
      avaliarAlertas: async () => { throw Error('unexpected avaliarAlertas'); },
    },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async (sub) => { state.identityLookups++; return identityDeleted ? null : ({ userId: 7, sub, email: 'a@b.test', nome: 'Test', papel: 'admin' }); },
      usuarioDoPortao: async (papel) => ({ userId: 7, sub: null, email: 'a@b.test', nome: 'Test', papel }),
      garantirUsuario: async () => { throw Error('unexpected garantirUsuario'); },
    },
    oidc: {
      oidcLigado: () => true,
      iniciarLogin: async () => { throw Error('unexpected iniciarLogin'); },
      concluirLogin: async () => { throw Error('unexpected concluirLogin'); },
      loginPorSenha: async () => { throw Error('unexpected loginPorSenha'); },
      urlDeLogout: async () => null,
      COOKIE_OIDC: 'radar_oidc', COOKIE_PKCE: 'radar_pkce',
    },
    jobs: {
      connectors: [],
      createCollectQueue: (connection) => { state.queueCreated++; if (!connection) throw Error('queue connection required'); return { add: async () => { throw Error('unexpected queue.add'); }, close: async () => { state.queueClosed++; } }; },
    },
    runtime: {
      makeRedis: () => {
        const index = state.redis++;
        if (index > 2) throw Error('unexpected Redis client');
        const client = {
          status: 'wait',
          connect: async () => { state.connected++; client.status = 'ready'; return 'OK'; },
          get: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected get'); return null; },
          incr: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected incr'); return 1; },
          expire: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected expire'); return 1; },
          del: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected del'); return 1; },
          subscribe: async (channel) => { if (channel !== 'lot-updates') throw Error('unexpected subscribe'); state.subscribed++; client.status = 'ready'; },
          on: (event, listener) => { if (!['message', 'error'].includes(event) || typeof listener !== 'function') throw Error('unexpected Redis listener'); },
          quit: async () => 'OK', disconnect: () => { client.status = 'end'; },
        };
        return client;
      }, CHANNEL_UPDATES: 'lot-updates',
      // Fixture: never touches a real Redis. The host owns this client, so quit/disconnect
      // must happen exactly once at app.close.
      createAntibotRedis: (url) => {
        state.antibotUrl = url;
        const client = {
          status: 'wait',
          connect: async () => { state.antibotRedisConnected++; client.status = 'ready'; return 'OK'; },
          on: (event, listener) => { if (event !== 'error' || typeof listener !== 'function') throw Error('unexpected antibot Redis listener'); },
          defineCommand: (name) => {
            if (name !== 'rateLimit') throw Error('unexpected antibot Redis command');
            client[name] = (_key, timeWindow, _max, _continue, _backoff, cb) => cb(null, [1, timeWindow]);
          },
          quit: async () => { state.antibotRedisClosed++; client.status = 'end'; return 'OK'; },
          disconnect: () => { state.antibotRedisClosed++; client.status = 'end'; },
        };
        return client;
      },
      createWsRedis: (url) => { state.wsUrl = url; const client = { status: 'wait', connect: async () => { state.connected++; client.status = 'ready'; return 'OK'; }, on: (event, listener) => { if (event !== 'error' || typeof listener !== 'function') throw Error('unexpected ws Redis listener'); }, eval: async () => 1, quit: async () => 'OK', disconnect: () => { client.status = 'end'; } }; return client; },
      hostsTlsIncomplete: new Set(),
      initialize: async () => { state.init++; },
      close: async () => { state.closes++; },
      ...(mode === 'off' || !injectDriver ? {} : { createAntibotDriver: () => ({ check: async (policy) => { state.driverChecks.push(policy.id); return { allowed: policy.id !== 'search' && policy.id !== 'vitrine', ttlMs: 1_500 }; }, ping: async () => {}, close: async () => { state.protectionClosed++; } }) }),
    },
  };
  return { deps, state };
}

async function hostFor(options = {}) {
  const { deps, state } = dependencies(options);
  const host = await createLegacyHost({
    env: { NODE_ENV: 'test', ANTIBOT_MODE: options.mode ?? 'off', ANTIBOT_REDIS_URL: 'redis://antibot.fixture:6391', REDIS_URL: 'redis://queue.fixture:6380', CHALLENGE_MODE: 'off' }, paths, dependencies: deps,
  });
  return { ...host, state };
}
const sessionHeaders = () => ({ cookie: `radar_sessao=${auth.criarToken('admin', 'host-test-sub')}` });

test('real legacy routes preserve auth, static assets, headers, errors and single-owner resources', async () => {
  const host = await hostFor();
  try {
    assert.equal(host.state.init, 0, 'factory does not initialize resources implicitly');
    assert.equal(host.state.queries.length, 0);
    assert.equal(host.state.subscribed, 0);
    assert.equal(host.state.queueCreated, 0);
    assert.equal(host.state.connected, 0);
    assert.equal((await host.app.inject('/login')).statusCode, 200);
    const landing = await host.app.inject('/');
    assert.equal(landing.statusCode, 200);
    assert.match(landing.body, /Radar/);
    const asset = await host.app.inject('/landing.js');
    assert.equal(asset.statusCode, 200);
    for (const response of [landing, asset]) assert.ok(response.headers['content-security-policy']);
    // challenge/metrics são montados depois do 404/handler de erro e dos cabeçalhos.
    const challengeAsset = await host.app.inject('/challenge.js');
    assert.equal(challengeAsset.statusCode, 200);
    assert.equal(challengeAsset.headers['x-content-type-options'], 'nosniff');
    assert.ok(challengeAsset.headers['content-security-policy']);

    const anonymousBrands = await host.app.inject('/api/brands');
    assert.equal(anonymousBrands.statusCode, 401);
    assert.equal(anonymousBrands.headers['cache-control'], 'no-store');
    const invalid = await host.app.inject({ url: '/api/brands', headers: { cookie: 'radar_sessao=invalid' } });
    assert.equal(invalid.statusCode, 401);
    assert.equal(host.state.queries.length, 0, 'unauthenticated route does not query');
    assert.equal((await host.app.inject('/api/search')).statusCode, 401);
    assert.equal((await host.app.inject('/busca')).statusCode, 302);
    assert.equal((await host.app.inject('/lote/lot-7')).statusCode, 302);
    assert.equal((await host.app.inject({ url: '/login', headers: { cookie: 'radar_sessao=bad' } })).statusCode, 200);

    const headers = sessionHeaders();
    const brands = await host.app.inject({ url: '/api/brands', headers });
    assert.equal(brands.statusCode, 200);
    assert.ok(Array.isArray(brands.json().known));
    assert.deepEqual(brands.json().present, [{ brand: 'FORD', count: 2 }]);
    assert.equal(brands.headers['cache-control'], 'no-store');
    const head = await host.app.inject({ method: 'HEAD', url: '/api/brands', headers });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(host.state.queries.filter((sql) => sql === BRANDS_SQL).length, 2);

    const deletedHost = await hostFor({ identityDeleted: true });
    try {
      const deleted = await deletedHost.app.inject({ url: '/api/brands', headers });
      assert.equal(deleted.statusCode, 401);
      assert.deepEqual(deleted.json(), { error: 'unauthorized' });
      assert.equal(deletedHost.state.queries.length, 0);
    } finally { await deletedHost.app.close(); }

    const unknownPage = await host.app.inject({ url: '/private', headers: { ...headers, accept: 'text/html' } });
    assert.equal(unknownPage.statusCode, 404);
    assert.match(unknownPage.headers['content-type'], /text\/html/);
    assert.ok(unknownPage.headers['content-security-policy']);
    const unknownApi = await host.app.inject({ url: '/api/no-route', headers });
    assert.equal(unknownApi.statusCode, 404);
    assert.deepEqual(unknownApi.json(), { erro: 'não encontrado', rota: '/api/no-route' });

    const failedHost = await hostFor({ queryFailure: true });
    try {
      const failed = await failedHost.app.inject({ url: '/api/brands', headers });
      assert.equal(failed.statusCode, 500);
      assert.deepEqual(failed.json(), { erro: 'erro interno' });
      assert.doesNotMatch(failed.body, /db secret/);
      assert.ok(failed.headers['content-security-policy']);
      const retry = await failedHost.app.inject({ url: '/api/brands', headers });
      assert.equal(retry.statusCode, 200, 'failure must release the read lease');
    } finally { await failedHost.app.close(); }

    await Promise.all([host.initializeResources(), host.initializeResources()]);
    assert.equal(host.state.init, 1);
    assert.equal(host.state.queueCreated, 1);
    assert.equal(host.state.subscribed, 1);
    assert.equal(host.state.connected, 1, 'login Redis connects only during explicit initialization');
    assert.equal(host.state.ensured, 1);
    assert.equal(host.state.queries.filter((sql) => PHOTO_HOSTS_SQL.test(sql)).length, 1);
  } finally { await host.app.close(); }
  assert.equal(host.state.closes, 1);
  assert.equal(host.state.queueClosed, 1);
});

test('startup failure is memoized and closes initialized ownership', async () => {
  const host = await hostFor({ startupFailure: true });
  await assert.rejects(host.initializeResources(), /startup fixture/);
  await assert.rejects(host.initializeResources(), /startup fixture/);
  assert.equal(host.state.init, 1);
  assert.equal(host.state.ensured, 1);
  assert.equal(host.state.queueClosed, 1);
  assert.equal(host.state.closes, 1);
});

test('OIDC-off host is rejected without silently opening auth', async () => {
  const { deps, state } = dependencies();
  deps.oidc.oidcLigado = () => false;
  await assert.rejects(createLegacyHost({ env: { NODE_ENV: 'test' }, paths, dependencies: deps }), /OIDC obrigatório/);
  assert.equal(state.init, 0);
  assert.equal(state.queries.length, 0);
});

test('shadow/enforce wires the supplied Redis driver and uses the configured WS URL without fallback', async () => {
  const host = await hostFor({ mode: 'enforce' });
  try {
    assert.equal(host.state.antibotUrl, '', 'driver injection bypasses the production Redis constructor');
    assert.equal(host.state.wsUrl, 'redis://antibot.fixture:6391');
    const publicLimited = await host.app.inject('/api/security-config');
    assert.equal(publicLimited.statusCode, 429);
    assert.equal(publicLimited.headers['retry-after'], '2');
    const unauthorized = await host.app.inject('/api/search');
    assert.equal(unauthorized.statusCode, 401);
    const accountLimited = await host.app.inject({ url: '/api/search', headers: sessionHeaders() });
    assert.equal(accountLimited.statusCode, 429);
    assert.ok(host.state.driverChecks.includes('vitrine'));
    assert.ok(host.state.driverChecks.includes('search'));
    assert.equal(host.state.queries.length, 0);
    assert.equal(host.state.identityLookups, 1);
  } finally { await host.app.close(); }
  assert.equal(host.state.protectionClosed, 1, 'antibot protection closes exactly once');
});

test('host-owned antibot Redis connects at initialization and closes exactly once', async () => {
  const host = await hostFor({ mode: 'enforce', injectDriver: false });
  try {
    assert.equal(host.state.antibotUrl, 'redis://antibot.fixture:6391', 'no injected driver means the host builds its own client');
    assert.equal(host.state.antibotRedisConnected, 0);
    await host.initializeResources();
    assert.equal(host.state.antibotRedisConnected, 1, 'antibot Redis connects during initialization');
    assert.equal(host.state.antibotRedisClosed, 0, 'antibot Redis stays open while the host runs');
  } finally { await host.app.close(); }
  assert.equal(host.state.antibotRedisClosed, 1, 'antibot Redis closes exactly once with the host');
  assert.equal(host.state.protectionClosed, 0, 'an injected driver is absent in this scenario');
});
