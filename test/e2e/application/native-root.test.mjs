import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { dependencies } from '../../../scripts/fixtures/host-fixture.mjs';
import { createRadarApplication } from '../../../dist/src/bootstrap/native-application.js';
import { criarToken } from '../../../dist/src/core/auth.js';

describe('full native Nest root composition', () => {
  let app;
  let state;
  let calls;
  let additions;
  let assetFile;
  let assetBytes;
  let assetName;
  let failBrands = false;
  const ownerId = 7;
  const adminCookie = `radar_sessao=${criarToken('admin')}`;
  const userCookie = `radar_sessao=${criarToken('comum')}`;

  beforeAll(async () => {
    const fixture = dependencies();
    state = fixture.state;
    calls = [];
    additions = [];
    const redisClients = [];
    fixture.deps.data.ensureSources = async () => { state.ensured++; };
    fixture.deps.data.searchLots = async () => ({ items: [], page: 1, pageSize: 25, total: 0 });
    fixture.deps.data.searchLotsMapa = async () => ({ items: [], total: 0 });
    fixture.deps.data.query = async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('jsonb_array_elements_text(photos)')) return [];
      if (sql === 'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC') {
        if (failBrands) throw new Error('database credentials must not leak');
        return [{ brand: 'FORD', count: 2 }];
      }
      if (sql.includes('FROM favorites f JOIN lots l') && sql.includes('AS total')) return [{ total: 1 }];
      if (sql.includes('FROM favorites f JOIN lots l') && sql.includes('ORDER BY f.created_at')) return [];
      if (sql.includes('FROM favorites f') && sql.includes('AS count')) return [{ count: 2 }];
      if (sql.includes('FROM alert_hits h') && sql.includes('AS count')) return [{ count: 3 }];
      if (sql.startsWith('SELECT COUNT(*)::int AS count FROM lots')) return [{ count: 0 }];
      if (sql.includes('AS value, COUNT(*)::int AS count')) return [];
      if (sql.startsWith('SELECT id, source_id, lot_url')) return [];
      if (sql.includes('AS "totalLeiloeiros"')) return [{ fontes: 1, total: 2, totalLeiloeiros: 1_193, novos24h: 1, encerram24h: 0 }];
      if (sql.includes('AS c0')) return [{ c0: 0, c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 }];
      if (sql.includes('SELECT state AS uf')) return [];
      if (sql.includes('SELECT auctioneer_name AS nome')) return [];
      if (sql.includes('FROM generate_series(1, 12)')) return Array.from({ length: 12 }, (_, index) => ({ h: index + 1, total: 0 }));
      if (sql.includes('SELECT DISTINCT ON (cat)')) return [];
      if (sql.includes('row_number() OVER')) return [];
      if (sql.includes('SELECT id, title_display')) return [];
      throw new Error(`unexpected root fixture SQL: ${sql}`);
    };
    fixture.deps.identity.usuarioDoPortao = async (papel) => ({ userId: ownerId, sub: null, email: 'user@example.test', nome: 'Test', papel });
    fixture.deps.jobs.connectors = [{ def: { id: 'fixture-source' } }];
    fixture.deps.jobs.createCollectQueue = (connection) => {
      state.queueCreated++;
      if (!connection) throw new Error('queue connection required');
      return { add: async (...args) => { additions.push(args); return { id: `manual-${additions.length}` }; }, close: async () => { state.queueClosed++; } };
    };
    fixture.deps.runtime.makeRedis = () => {
      const listeners = new Map();
      const client = {
        status: 'wait',
        connect: async () => { client.status = 'ready'; return 'OK'; },
        get: async () => null, incr: async () => 1, expire: async () => 1, del: async () => 1,
        subscribe: async () => 1, unsubscribe: async () => 1,
        on: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); return client; },
        off: (event, listener) => { listeners.get(event)?.delete(listener); return client; },
        quit: async () => { state.redisClosed = (state.redisClosed ?? 0) + 1; client.status = 'end'; return 'OK'; },
        disconnect: () => { client.status = 'end'; },
      };
      redisClients.push(client);
      return client;
    };
    fixture.deps.runtime.close = async () => { state.closes++; };

    const env = { NODE_ENV: 'test', SITE_URL: 'https://radar.example.test' };
    const appDist = join(process.cwd(), 'app-busca', 'dist');
    const assetsDir = join(appDist, 'client', 'assets');
    assetBytes = Buffer.from('window.__nativeRootAssetProbe = "ok";\n');
    const digest = createHash('sha256').update(assetBytes).digest('hex').slice(0, 12);
    assetName = `native-root-probe.${digest}.js`;
    assetFile = join(assetsDir, assetName);
    await mkdir(assetsDir, { recursive: true });
    await writeFile(assetFile, assetBytes, { flag: 'wx' });
    app = await createRadarApplication({ env, paths: {
      projectRoot: process.cwd(), webRoot: `${process.cwd()}/src/web`, appDist,
      certDir: `${process.cwd()}/certs`, dataDir: `${process.cwd()}/data`,
    }, dependencies: fixture.deps });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
      await app?.close();
      expect(state.closes).toBe(1);
      expect(state.queueClosed).toBe(1);
      expect(state.redisClosed).toBe(2);
    } finally {
      if (assetFile) await unlink(assetFile).catch(() => {});
    }
  }, 60_000);

  it('composes public pages, vitrine, image placeholder, and keeps account APIs private', async () => {
    const server = app.getHttpServer();
    expect((await request(server).get('/')).status).toBe(200);
    expect((await request(server).get('/nopic.svg')).status).toBe(200);
    const vitrine = await request(server).get('/api/vitrine');
    expect(vitrine.status).toBe(200);
    expect(vitrine.body.totalLeiloeiros).toBe(1_193);
    const image = await request(server).get('/api/img').query({ u: 'https://unlisted.example.test/photo.jpg' });
    expect(image.status).toBe(200);
    expect(image.headers['x-nopic-motivo']).toBe('host-not-allowed');
    expect((await request(server).get('/api/me')).status).toBe(401);
  });

  it('mounts a compiled content-addressed client asset publicly with immutable one-year cache headers', async () => {
    const response = await request(app.getHttpServer()).get(`/assets/${assetName}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toContain('max-age=31536000');
    expect(response.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(response.text)).toEqual(assetBytes);
  });

  it('routes signed account identity through me, search, brands, and owner-scoped favorites', async () => {
    const server = app.getHttpServer();
    const me = await request(server).get('/api/me').set('Cookie', userCookie);
    expect(me.status).toBe(200);
    expect(me.body.conta.id).toBe(ownerId);
    expect(me.body.favoriteCount).toBe(2);
    const search = await request(server).get('/api/search').set('Cookie', userCookie);
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);
    const brands = await request(server).get('/api/brands').set('Cookie', userCookie);
    expect(brands.status).toBe(200);
    expect(brands.body.present).toEqual([{ brand: 'FORD', count: 2 }]);
    const favorites = await request(server).get('/api/favorites').set('Cookie', userCookie);
    expect(favorites.status).toBe(200);
    expect(favorites.body.total).toBe(1);
    expect(calls.some(({ sql, params }) => sql.includes('FROM favorites f JOIN lots l') && params[0] === ownerId)).toBe(true);
  });

  it('enforces admin metrics/collection roles and enqueues only an explicit valid request', async () => {
    const server = app.getHttpServer();
    const deniedMetrics = await request(server).get('/api/security/metrics').set('Cookie', userCookie);
    expect(deniedMetrics.status).toBe(403);
    expect(deniedMetrics.headers['cache-control']).toContain('no-store');
    const metrics = await request(server).get('/api/security/metrics').set('Cookie', adminCookie);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toHaveProperty('images.total.requests');
    expect((await request(server).post('/api/collect').set('Cookie', userCookie).send({ sourceId: 'fixture-source' })).status).toBe(403);
    expect(additions).toHaveLength(0);
    const queued = await request(server).post('/api/collect').set('Cookie', adminCookie).send({ sourceId: 'fixture-source', limit: 20 });
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual({ enfileirado: [{ sourceId: 'fixture-source', jobId: 'manual-1' }] });
    expect(additions).toEqual([['collect:manual', { sourceId: 'fixture-source', limit: 20 }]]);
  });

  it('keeps strict validation and masks unexpected failures, then closes shared runtime once', async () => {
    const server = app.getHttpServer();
    const malformed = await request(server).get('/api/search?unexpected=1').set('Cookie', userCookie);
    expect(malformed.status).toBe(400);
    failBrands = true;
    const error = await request(server).get('/api/brands').set('Cookie', userCookie);
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ erro: 'erro interno' });
    expect(JSON.stringify(error.body)).not.toContain('credentials');
    failBrands = false;
  });
});
