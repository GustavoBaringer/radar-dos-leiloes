import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerBrandsRoute, BRANDS_SQL } from '../src/modules/catalogo/adapters/http/brands.legacy.js';
import { createHttpResourceGuard } from '../src/core/antibot/http-resources.js';

test('legacy brands route retains SQL, response envelope, methods and resource lease', async () => {
  const app = Fastify();
  let acquired = 0;
  let released = 0;
  let queried = '';
  const lease = () => ({ release: () => { released += 1; } });
  const resources = createHttpResourceGuard({
    tryAcquireResource: () => { acquired += 1; return lease(); },
    acquireDegradedWork: () => lease(),
  });
  const withReadResources = (handler: (req: any, reply: any) => unknown | Promise<unknown>) =>
    (req: any, reply: any) => resources.run(reply, () => handler(req, reply));
  const rows = [{ brand: 'FORD', count: 4 }];
  registerBrandsRoute(app, async (sql) => { queried = sql; return rows; }, withReadResources, ['FORD', 'GM']);
  try {
    const get = await app.inject('/api/brands');
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.json(), { known: ['FORD', 'GM'], present: rows });
    assert.equal(queried, 'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC');
    const head = await app.inject({ method: 'HEAD', url: '/api/brands' });
    assert.equal(head.statusCode, get.statusCode);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(acquired, 2);
    assert.equal(released, 4);
    assert.equal(BRANDS_SQL, queried);
  } finally {
    await app.close();
  }
});

test('brands query failure remains bounded by resource-guard finally release', async () => {
  const app = Fastify();
  let released = 0;
  const resources = createHttpResourceGuard({
    tryAcquireResource: () => ({ release: () => { released += 1; } }),
    acquireDegradedWork: () => ({ release: () => { released += 1; } }),
  });
  registerBrandsRoute(app, async () => { throw new Error('fixture failure'); },
    (handler) => (req, reply) => resources.run(reply, () => handler(req, reply)), []);
  try {
    const response = await app.inject('/api/brands');
    assert.equal(response.statusCode, 500);
    assert.equal(released, 2);
  } finally {
    await app.close();
  }
});
