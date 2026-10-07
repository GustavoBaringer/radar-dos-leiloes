import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import Fastify from 'fastify';
import { dependencies, BRANDS_SQL } from './fixtures/host-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = process.env.HOST_VARIANT === 'compiled';
const entry = compiled ? 'dist/src' : 'src';
const ext = compiled ? 'js' : 'ts';
const fromEntry = (name) => pathToFileURL(resolve(root, entry, `${name}.${ext}`)).href;

const [{ createLegacyNestHostBrands, LegacyOwnedFastifyAdapter }, { createLegacyHost }, auth, pathsModule, normalize] =
  await Promise.all([
    import(fromEntry('legacy-nest-host-brands')),
    import(fromEntry('legacy-host')),
    import(fromEntry('core/auth')),
    import(fromEntry('bootstrap/paths')),
    import(fromEntry('core/normalize')),
  ]);

const paths = pathsModule.resolveHttpPaths(fromEntry('server'));
assert.ok(existsSync(resolve(paths.webRoot, 'landing-antibot.html')), `missing fixture assets at ${paths.webRoot}`);
assert.equal(paths.projectRoot, root);
process.chdir('/');

const env = {
  NODE_ENV: 'test',
  ANTIBOT_MODE: 'off',
  ANTIBOT_REDIS_URL: 'redis://antibot.fixture:6391',
  REDIS_URL: 'redis://queue.fixture:6380',
  CHALLENGE_MODE: 'off',
};
const sessionHeaders = () => ({ cookie: `radar_sessao=${auth.criarToken('admin', 'nest-brands-sub')}` });

/** Piloto com o mesmo fixture de dependências; só a query de marcas é interceptada. */
async function pilotFor(options = {}, brandsQuery) {
  const { deps, state } = dependencies(options);
  if (brandsQuery) {
    const baseQuery = deps.data.query;
    deps.data.query = async (sql) => (sql === BRANDS_SQL ? brandsQuery() : baseQuery(sql));
  }
  const pilot = await createLegacyNestHostBrands({ env, paths, dependencies: deps });
  return { pilot, state };
}

test('adapter do piloto não regrava error/404 do host legado', async () => {
  const app = Fastify();
  const original = app.errorHandler;
  const adapter = new LegacyOwnedFastifyAdapter(app);
  const foreign = () => {};
  assert.equal(adapter.setErrorHandler(foreign), app, 'setErrorHandler devolve a instância');
  assert.equal(adapter.setNotFoundHandler(foreign), app, 'setNotFoundHandler devolve a instância');
  assert.equal(app.errorHandler, original, 'o handler legado continua sendo o mesmo');
  await app.close();
});

test('piloto Nest assume /api/brands sem tocar no handler global do host', async () => {
  const { pilot, state } = await pilotFor();
  const { host, nest } = pilot;
  try {
    assert.equal(pilot.brandsRoute, 'nest', 'a rota registrada é a do Nest');
    assert.equal(host.legacyBrandsRegistered, false, 'a rota legada foi excluída nesta montagem');
    assert.equal(state.init, 0, 'a fábrica não inicializa recursos implicitamente');
    assert.equal(state.queries.length, 0, 'a fábrica não consulta o banco');
    assert.ok(nest, 'o Nest fica disponível para o dono externo fechar');
  } finally {
    await nest.close();
  }
  assert.equal(state.closes, 1, 'nest.close fecha o Fastify do host uma vez');
});

test('porta de marcas no Nest preserva auth, SQL, envelope, HEAD e cabeçalhos', async () => {
  const { pilot, state } = await pilotFor();
  try {
    assert.equal((await pilot.host.app.inject('/api/brands')).statusCode, 401);
    assert.equal(
      (await pilot.host.app.inject({ url: '/api/brands', headers: { cookie: 'radar_sessao=invalid' } })).statusCode,
      401,
    );
    assert.equal(state.queries.length, 0, 'sessão inválida não chega ao banco');

    const headers = sessionHeaders();
    const brands = await pilot.host.app.inject({ url: '/api/brands', headers });
    assert.equal(brands.statusCode, 200);
    assert.deepEqual(brands.json(), { known: normalize.BRAND_LIST, present: [{ brand: 'FORD', count: 2 }] });
    assert.equal(state.queries.filter((sql) => sql === BRANDS_SQL).length, 1, 'SQL central único');
    assert.equal(brands.headers['cache-control'], 'no-store');
    assert.ok(brands.headers['content-security-policy'], 'CSP do host cobre a rota do Nest');
    assert.equal(brands.headers['x-content-type-options'], 'nosniff');

    const head = await pilot.host.app.inject({ method: 'HEAD', url: '/api/brands', headers });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], brands.headers['content-type']);
  } finally {
    await pilot.nest.close();
  }
});

test('conta apagada responde 401 do host sem consultar a rota do Nest', async () => {
  const { pilot, state } = await pilotFor({ identityDeleted: true });
  try {
    const response = await pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
    assert.equal(state.queries.length, 0);
  } finally {
    await pilot.nest.close();
  }
});

test('exceções do controller saem pelo handler legado: 4xx com mensagem, 5xx mascarado', async () => {
  const failure = await pilotFor({ queryFailure: true });
  try {
    const failed = await failure.pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { erro: 'erro interno' });
    assert.doesNotMatch(failed.body, /db secret/);
    assert.ok(failed.headers['content-security-policy']);
    const retry = await failure.pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(retry.statusCode, 200, 'falha de query libera a leitura');
  } finally {
    await failure.pilot.nest.close();
  }

  const status400 = await pilotFor({}, () => {
    throw Object.assign(new Error('marca inválida'), { statusCode: 400 });
  });
  try {
    const response = await status400.pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { erro: 'marca inválida' });
  } finally {
    await status400.pilot.nest.close();
  }

  const http400 = await pilotFor({}, () => {
    throw new BadRequestException('marcas fora do ar');
  });
  try {
    const response = await http400.pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { erro: 'marcas fora do ar' });
  } finally {
    await http400.pilot.nest.close();
  }

  const http503 = await pilotFor({}, () => {
    throw new ServiceUnavailableException('detalhe secreto do upstream');
  });
  try {
    const response = await http503.pilot.host.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(response.statusCode, 500, 'HttpException 5xx vira 500 no contrato atual');
    assert.deepEqual(response.json(), { erro: 'erro interno' });
    assert.doesNotMatch(response.body, /detalhe secreto/);
  } finally {
    await http503.pilot.nest.close();
  }
});

test('404 de API e navegação, redirecionamentos e auth continuam do host legado', async () => {
  const { pilot } = await pilotFor();
  try {
    const headers = sessionHeaders();
    const api404 = await pilot.host.app.inject({ url: '/api/rota-do-piloto', headers });
    assert.equal(api404.statusCode, 404);
    assert.deepEqual(api404.json(), { erro: 'não encontrado', rota: '/api/rota-do-piloto' });

    const page404 = await pilot.host.app.inject({
      url: '/pagina-do-piloto',
      headers: { ...headers, accept: 'text/html' },
    });
    assert.equal(page404.statusCode, 404);
    assert.match(page404.headers['content-type'], /text\/html/);
    assert.ok(page404.headers['content-security-policy']);

    assert.equal((await pilot.host.app.inject('/busca')).statusCode, 302);
    assert.equal((await pilot.host.app.inject('/lote/lot-7')).statusCode, 302);
    assert.equal((await pilot.host.app.inject('/api/search')).statusCode, 401);
  } finally {
    await pilot.nest.close();
  }
});

test('parsers do host seguem intactos com bodyParser desligado no Nest', async () => {
  const { pilot, state } = await pilotFor();
  try {
    const malformed = await pilot.host.app.inject({
      method: 'POST',
      url: '/api/espera',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    assert.equal(malformed.statusCode, 400);

    const oversized = await pilot.host.app.inject({
      method: 'POST',
      url: '/api/espera',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.test', consentimento: 'x'.repeat(20 * 1024) }),
    });
    assert.equal(oversized.statusCode, 413, 'bodyLimit de 16 KiB do host vale');

    const form = await pilot.host.app.inject({
      method: 'POST',
      url: '/api/espera',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=invalido',
    });
    assert.equal(form.statusCode, 400);
    assert.deepEqual(form.json(), { erro: 'e-mail inválido' }, 'formbody chegou ao handler legado');

    assert.equal(state.queries.length, 0, 'nenhuma chamada externa no parsing');
  } finally {
    await pilot.nest.close();
  }
});

test('nest.close é o dono único dos recursos; fechamento duplo não repete', async () => {
  const { pilot, state } = await pilotFor();
  await pilot.host.initializeResources();
  assert.equal(state.init, 1);
  assert.equal(state.queueCreated, 1);
  assert.equal(state.subscribed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ensured, 1);

  await pilot.nest.close();
  assert.equal(state.closes, 1);
  assert.equal(state.queueClosed, 1);

  await pilot.host.app.close();
  assert.equal(state.closes, 1, 'close do host continua memoizado');
  assert.equal(state.queueClosed, 1);
});

test('server padrão do stage2 continua sem referência ao piloto', async () => {
  const source = readFileSync(resolve(root, entry, `server.${ext}`), 'utf8');
  assert.doesNotMatch(source, /legacy-nest-host/, 'o entrypoint não monta o piloto');

  const { deps, state } = dependencies();
  const plain = await createLegacyHost({ env, paths, dependencies: deps });
  try {
    assert.equal(plain.legacyBrandsRegistered, true, 'padrão continua registrando a rota legada');
    const response = await plain.app.inject({ url: '/api/brands', headers: sessionHeaders() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().present, [{ brand: 'FORD', count: 2 }]);
    assert.equal(state.queries.filter((sql) => sql === BRANDS_SQL).length, 1);
  } finally {
    await plain.app.close();
  }
});
