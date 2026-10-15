import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryContext } from '../src/bootstrap/discovery-context.js';
import type { DiscoveryRepositoryPort } from '../src/infra/discovery/discovery.repository.js';
import type { DiscoveryHttpPort } from '../src/infra/discovery/discovery.http.js';

test('DiscoveryService is composed by Nest with isolated repository and HTTP ports', async () => {
  const events: unknown[] = [];
  const repo: DiscoveryRepositoryPort = {
    startRun: async (...args) => { events.push(['start', ...args]); return 7; },
    finishRun: async (...args) => { events.push(['finish', ...args]); },
    upsertAuctioneer: async (params) => { events.push(['auctioneer', params]); return { domain: 'persisted.example.com' }; },
    upsertSite: async (...args) => { events.push(['site', ...args]); },
    siteCounts: async () => ({ total: 1, pendentes: 1 }),
    sites: async () => [{ domain: 'fixture.example', platform: 'manual-platform' }],
    sitesByDomains: async () => [{ domain: 'fixture.example', platform: 'manual-platform' }],
    hasLots: async () => false,
    updateProbe: async (...args) => { events.push(['probe-update', ...args]); },
  };
  const http: DiscoveryHttpPort = {
    fenajuPage: async () => ({ data: [{ id: 99, nome: 'Fixture', dominio: 'declared.example', dominio_url: 'tenant.leilao.br', email: 'x@fallback.example', juntaUF: 'sp', situacao: 'Regular' }], totalPages: 1 }),
    probe: async (url) => url.includes('__nao-existe-radar-')
      ? { status: 404, body: 'x'.repeat(500) }
      : { status: 200, body: `<title>Fixture</title>${' '.repeat(200)}<a href="/leilao/1">lance inicial</a>` },
  };
  const context = await createDiscoveryContext({ dependencies: { repository: repo, http } });
  try {
    const result = await context.service.rodarDescoberta('fenaju');
    assert.deepEqual(result, { leiloeiros: 1, comLeilaoBr: 1, sitesNoCatalogo: 1, aSondar: 1 });
    const params = (events.find((event) => Array.isArray(event) && event[0] === 'auctioneer') as any[])[1];
    assert.equal(params[6], 'declared.example');
    assert.deepEqual(events.find((event) => Array.isArray(event) && event[0] === 'site'), ['site', 'persisted.example.com', 1, ['SP']]);
    assert.deepEqual(events.at(-1), ['finish', 7, { ok: true, fetched: 1, upserted: 1, skipped: 1 }]);

    await context.service.sondarDominios(['fixture.example'], 1);
    const write = events.find((event) => Array.isArray(event) && event[0] === 'probe-update') as any[];
    assert.equal(write[1], 'fixture.example');
    assert.equal(write[2].platform, 'html-agenda');
    assert.equal(write[3], null, 'unmapped detected platform does not overwrite connector/platform authority');
  } finally { await context.close(); }
});

test('a FENAJU transport error marks the discovery run failed without touching catalog data', async () => {
  const events: unknown[] = [];
  const repo: DiscoveryRepositoryPort = {
    startRun: async () => 8,
    finishRun: async (...args) => { events.push(args); },
    upsertAuctioneer: async () => { events.push('upsert'); return undefined; },
    upsertSite: async () => { events.push('site'); },
    siteCounts: async () => ({ total: 0, pendentes: 0 }),
    sites: async () => [], sitesByDomains: async () => [], hasLots: async () => false,
    updateProbe: async () => { events.push('probe-update'); },
  };
  const http: DiscoveryHttpPort = { fenajuPage: async () => { throw new Error('fixture transport error'); }, probe: async () => { throw new Error('unused'); } };
  const context = await createDiscoveryContext({ dependencies: { repository: repo, http } });
  try {
    await assert.rejects(context.service.rodarDescoberta('fenaju'), /fixture transport error/);
    assert.deepEqual(events, [[8, { ok: false, error: 'fixture transport error' }]]);
  } finally { await context.close(); }
});
