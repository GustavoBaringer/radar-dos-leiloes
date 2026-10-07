import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { BoundedInputError, parseSearchInput } from '../src/core/request-bounds.js';

test('aceita o query real do Fastify com CSV e arrays, sem relaxar a validação', async () => {
  const app = Fastify({ logger: false });
  app.get('/search', (req) => {
    const parsed = parseSearchInput(req.query);
    return { q: parsed.q, yearMin: parsed.yearMin, page: parsed.page, pageSize: parsed.pageSize, vehicleType: parsed.vehicleType, docType: parsed.docType };
  });
  app.get('/invalid-prototype', () => parseSearchInput(Object.create(Object.assign(Object.create(null), { inherited: 'x' }))));
  app.get('/invalid-object', () => parseSearchInput([]));

  try {
    const csv = await app.inject({
      method: 'GET',
      url: '/search?q=Hilux&yearMin=2021&vehicleType=carro%2Cpicape%2Csuv&docType=conservado%2Crecuperado_financiamento%2Cjudicial&page=2&pageSize=24',
    });
    assert.equal(csv.statusCode, 200, csv.body);
    assert.deepEqual(csv.json(), {
      q: 'Hilux', yearMin: 2021, page: 2, pageSize: 24,
      vehicleType: ['carro', 'picape', 'suv'],
      docType: ['conservado', 'recuperado_financiamento', 'judicial'],
    });

    const repeatedLists = await app.inject({ method: 'GET', url: '/search?vehicleType=carro&vehicleType=suv&docType=judicial&docType=sucata' });
    assert.equal(repeatedLists.statusCode, 200, repeatedLists.body);
    assert.deepEqual(repeatedLists.json().vehicleType, ['carro', 'suv']);
    assert.deepEqual(repeatedLists.json().docType, ['judicial', 'sucata']);

    const duplicateScalar = await app.inject({ method: 'GET', url: '/search?q=Hilux&q=Corolla' });
    assert.equal(duplicateScalar.statusCode, 400);

    const unknownKey = await app.inject({ method: 'GET', url: '/search?unexpected=value' });
    assert.equal(unknownKey.statusCode, 400);

    const invalidPrototype = await app.inject({ method: 'GET', url: '/invalid-prototype' });
    assert.equal(invalidPrototype.statusCode, 400);
    const invalidObject = await app.inject({ method: 'GET', url: '/invalid-object' });
    assert.equal(invalidObject.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('rejeita accessors e prototypes customizados no parser da query', () => {
  const getterInput = Object.defineProperty({}, 'q', { enumerable: true, get: () => 'não ler' });
  const customPrototype = Object.assign(Object.create(null), { inherited: 'campo herdado' });
  for (const input of [
    getterInput,
    Object.create(customPrototype),
    Object.create({ inherited: 'campo herdado' }),
    [],
  ]) {
    assert.throws(() => parseSearchInput(input), (error: unknown) => error instanceof BoundedInputError && error.statusCode === 400);
  }
});
