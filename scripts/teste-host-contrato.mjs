import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dependencies, BRANDS_SQL, PHOTO_HOSTS_SQL } from './fixtures/host-fixture.mjs';

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

test('push subscribe accepts browser expirationTime contract and rejects malformed/unknown fields', async () => {
  const host = await hostFor();
  try {
    const headers = sessionHeaders();
    const subscription = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'AQ==', auth: 'Ag==' } };
    for (const expirationTime of [null, 1_800_000_000_000]) {
      const response = await host.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { ...subscription, expirationTime } });
      assert.equal(response.statusCode, 200, response.body);
    }
    const omitted = await host.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: subscription });
    assert.equal(omitted.statusCode, 200, omitted.body);
    for (const expirationTime of [-1, 'soon', {}, false]) {
      const response = await host.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { ...subscription, expirationTime } });
      assert.equal(response.statusCode, 400, `expirationTime=${JSON.stringify(expirationTime)}`);
    }
    const nonFinite = await host.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { ...headers, 'content-type': 'application/json' }, payload: `{"endpoint":"${subscription.endpoint}","keys":${JSON.stringify(subscription.keys)},"expirationTime":1e400}` });
    assert.equal(nonFinite.statusCode, 400, 'non-finite JSON number rejected');
    const unknown = await host.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { ...subscription, extra: true } });
    assert.equal(unknown.statusCode, 400);
    assert.equal(host.state.pushSubscriptions.length, 3, 'expirationTime remains unpersisted');
    assert.equal(host.state.pushSubscriptions[0].length, 5, 'only existing subscription columns are persisted');
  } finally { await host.app.close(); }
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
