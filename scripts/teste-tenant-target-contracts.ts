import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { collectCakeTenant, parseCakeCards } from '../src/connectors/leiloar.js';
import { collectWebLeiloes, parseWebLote, suporteleiloes } from '../src/connectors/suporteleiloes.js';
import { executeCollection } from '../src/application/services/collection/collection-execution.js';
import { fetchTenantText, TenantScopeError } from '../src/connectors/http.js';

const root = new URL('../fixtures/', import.meta.url);
const load = async (path: string) => readFile(new URL(path, root), 'utf8');
const federalHome = await load('leiloar/federal/home.html');
const federalEvent = await load('leiloar/federal/event-335.html');
const prosperarCatalog = await load('leiloar/prosperar/catalog.html');
const webDetail = await load('suporteleiloes/webleiloes/apto-25897.html');
const vecchiHome = await load('suporteleiloes/vecchi/home.html');

function fakePages(pages: Record<string, string>, calls: string[]) {
  return async (url: string, tenant: string) => {
    assert.equal(new URL(url).hostname.replace(/^www\./, ''), tenant);
    calls.push(url);
    const body = pages[new URL(url).pathname + new URL(url).search];
    if (!body) throw new Error(`fixture ausente: ${url}`);
    return { status: 200, body, headers: {}, url };
  };
}

test('CakePHP fixtures map Federal compressor and Prosperar residence without guessing routes', async () => {
  const calls: string[] = [];
  const federal = await collectCakeTenant('leiloesfederal.com.br', 13, fakePages({ '/': federalHome, '/leilao/335': federalEvent }, calls));
  assert.equal(federal.fetched, 13);
  assert.equal(federal.lots.length, 11);
  assert.equal(federal.skipped, 2, 'unsupported data-printer assets are excluded, not forced to a supported type');
  assert.ok(!federal.lots.some(lot => /:(392|393)$/.test(lot.externalId)));
  const compressor = federal.lots.find(lot => lot.externalId.endsWith(':394'))!;
  assert.ok(compressor);
  assert.match(compressor.titleRaw, /COMPRESSOR DE REFRIGERAÇÃO INDUSTRIAL/i);
  assert.equal(compressor.assetType, 'veiculo');
  assert.equal(compressor.vehicleType, 'maquina');
  assert.equal(compressor.appraisal, 55000);
  assert.equal(compressor.minBid, 20000);
  assert.equal(compressor.status, 'aberto');
  assert.equal(compressor.auctionEndUtc?.toISOString(), '2026-10-27T16:00:00.000Z');
  assert.match(federal.note ?? '', /total geral não observado/);
  assert.match(federal.lots.find(lot => lot.externalId.endsWith(':384'))?.titleRaw ?? '', /Módulo Rural da Fazenda São Gonçalo/i);
  assert.equal(federal.lots.find(lot => lot.externalId.endsWith(':384'))?.city, 'Arinos');
  assert.equal(federal.lots.find(lot => lot.externalId.endsWith(':384'))?.state, 'MG');
  assert.match(federal.lots.find(lot => lot.externalId.endsWith(':387'))?.titleRaw ?? '', /Casa de 2 pavimentos/i);
  assert.equal(federal.lots.find(lot => lot.externalId.endsWith(':387'))?.city, 'Goiânia');
  assert.equal(federal.lots.find(lot => lot.externalId.endsWith(':387'))?.state, 'GO');
  const commercial = federal.lots.find(lot => lot.externalId.endsWith(':391'))!;
  assert.match(commercial.titleRaw, /Prédio Comercial com 900m²/i);
  assert.equal(commercial.assetType, 'imovel');
  assert.equal(commercial.propertyType, 'comercial');
  assert.deepEqual(calls.map(url => new URL(url).pathname), ['/','/leilao/335']);

  const prosperarCalls: string[] = [];
  const prosperar = await collectCakeTenant('prosperarleiloes.com.br', 5,
    fakePages({ '/externo/': prosperarCatalog }, prosperarCalls));
  const house = prosperar.lots.find(lot => lot.externalId.endsWith(':295'))!;
  assert.ok(house);
  assert.match(house.titleRaw, /Imóvel Residencial/i);
  assert.equal(house.assetType, 'imovel');
  assert.equal(house.appraisal, 1034840);
  assert.equal(house.minBid, 517420);
  assert.equal(house.auctionEndUtc?.toISOString(), '2026-11-04T14:30:00.000Z');
  assert.equal(house.status, 'aberto');
  assert.ok(prosperar.lots.some(lot => lot.status === 'encerrado'), 'suspended cards are not forced open');
  assert.match(prosperar.note ?? '', /denominador.*parcial/i);
});

test('Cake parser deduplicates repeated cards and rejects foreign URLs and unknown markup', () => {
  const card = parseCakeCards(federalEvent, 'https://www.leiloesfederal.com.br/leilao/335')[2];
  const duplicate = `<section class="card-bem">${`<a href="/lote/394/c">lote</a><div class="card-bem-descricao"><p>Compressor de Refrigeração Industrial</p></div>`}</section>`;
  assert.equal(parseCakeCards(duplicate + duplicate, 'https://www.leiloesfederal.com.br/leilao/335').length, 1);
  assert.deepEqual(parseCakeCards(duplicate.replace('/lote/394/c', 'https://evil.example/lote/394/c'), 'https://www.leiloesfederal.com.br/leilao/335'), []);
  assert.ok(card);
  assert.deepEqual(parseCakeCards('<html><body>schema alterado</body></html>', 'https://www.leiloesfederal.com.br/leilao/335'), []);
});

test('WebLeilões Yii Product parser maps the active instance and preserves conservative bid/status', async () => {
  const positive = parseWebLote(webDetail, 'https://www.webleiloes.com.br/imoveis/apartamentos/sp/guarulhos/apartamento-36m2-jardim-city-guarulhos-sp-25897');
  assert.ok(positive);
  assert.equal(positive.externalId, '25897');
  assert.equal(positive.assetType, 'imovel');
  assert.equal(positive.propertyType, 'apartamento');
  assert.equal(positive.minBid, 120947.88);
  assert.equal(positive.currentBid, null, 'Web current bid remains unknown without a validated bid contract');
  assert.equal(positive.auctionEndUtc?.toISOString(), '2026-10-21T17:00:00.000Z');
  assert.equal(positive.city, 'Guarulhos');

  const closedPrimary = webDetail.replace('card-status open badge badge-success text-white">Aberto', 'card-status badge badge-secondary text-white">Encerrado');
  assert.equal(parseWebLote(closedPrimary, 'https://www.webleiloes.com.br/imoveis/apartamento-25897')?.status, 'encerrado');
  assert.equal(parseWebLote(webDetail.replace('"@type":"Product"', '"@type":"Thing"'), 'https://www.webleiloes.com.br/imoveis/apartamentos/teste'), null);
});

test('WebLeilões fail-closed adapter and execution never reach the upsert spy', async () => {
  const requests: string[] = [];
  const blocked = await collectWebLeiloes('www.webleiloes.com.br', 1, undefined, (async (url: string) => {
    requests.push(url); throw new Error('must not fetch');
  }) as any);
  assert.deepEqual(blocked.lots, []);
  assert.match(blocked.note ?? '', /bloqueado: identidade dos 68.*não reconciliada/i);
  assert.deepEqual(requests, []);

  const existingLeilaoBrasil = { sourceId: 'suporteleiloes', externalId: '25897', lotUrl: 'https://leilaobrasil.com.br/lote/25897' };
  const untouchedExisting = { ...existingLeilaoBrasil };
  const attemptedWebWrites: unknown[][] = [];
  const dependencies = {
    lookupConnector: () => suporteleiloes,
    startRun: async () => 77,
    finishRun: async () => undefined,
    upsertLots: async (lots: unknown[]) => {
      attemptedWebWrites.push(lots.filter((lot: any) => lot.externalId === '25897' || /leilaobrasil\.com\.br/i.test(lot.lotUrl ?? '')));
      return { upserted: 0, novos: [], bidChanges: [] };
    },
    observerForCollection: () => undefined,
    processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
  } as any;
  for (const [limit, timeoutMs] of [[1, 100], [68, 30000]]) {
    await assert.rejects(executeCollection({ sourceId: 'suporteleiloes', tenant: 'webleiloes.com.br', limit, timeoutMs }, dependencies), /WebLeilões bloqueado/);
  }
  assert.deepEqual(attemptedWebWrites, [], 'blocked SKU 25897 never invokes persistence despite its existing collided row');
  assert.deepEqual(existingLeilaoBrasil, untouchedExisting, 'the existing cross-source identity record is not changed');
});

test('global collection canonicalizes Web aliases before observer/fetch and leaves Vecchi legacy active', async () => {
  const env = { domains: process.env.SUPORTELEILOES_DOMAINS, tenants: process.env.SUPORTELEILOES_TENANTS, ledger: process.env.TENANT_LEDGER_ENABLED };
  process.env.SUPORTELEILOES_DOMAINS = 'webleiloes.com.br,WWW.webleiloes.com.br,webleiloes.com.br.,WWW.webleiloes.com.br.,vecchileiloes.com.br';
  process.env.SUPORTELEILOES_TENANTS = '60';
  process.env.TENANT_LEDGER_ENABLED = '0';
  const requests: string[] = [], observed: string[] = [], blockedWrites: unknown[][] = [];
  const request = async (url: string) => {
    requests.push(url);
    const host = new URL(url).hostname;
    return { status: host === 'vecchileiloes.com.br' && new URL(url).pathname === '/leiloes' ? 404 : 200,
      body: host === 'vecchileiloes.com.br' && new URL(url).pathname === '/' ? vecchiHome : '', headers: {}, url };
  };
  const observer = { start: async (host: string) => {
    observed.push(host);
    return { response() {}, failure() {}, finish: async () => undefined };
  } };
  const connector = { ...suporteleiloes, collect: (options: any) => (suporteleiloes.collect as any)(options, request) };
  const deps = {
    lookupConnector: () => connector,
    startRun: async () => 78,
    finishRun: async () => undefined,
    upsertLots: async (lots: any[]) => {
      blockedWrites.push(lots.filter((lot) => lot.externalId === '25897' || /webleiloes\.com\.br|leilaobrasil\.com\.br/i.test(lot.lotUrl ?? '')));
      return { upserted: 0, novos: [], bidChanges: [] };
    },
    observerForCollection: () => observer,
    processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
  } as any;
  try {
    await executeCollection({ sourceId: 'suporteleiloes', limit: 50 }, deps);
  } finally {
    if (env.domains === undefined) delete process.env.SUPORTELEILOES_DOMAINS; else process.env.SUPORTELEILOES_DOMAINS = env.domains;
    if (env.tenants === undefined) delete process.env.SUPORTELEILOES_TENANTS; else process.env.SUPORTELEILOES_TENANTS = env.tenants;
    if (env.ledger === undefined) delete process.env.TENANT_LEDGER_ENABLED; else process.env.TENANT_LEDGER_ENABLED = env.ledger;
  }
  assert.ok(requests.length > 0 && requests.every((url) => new URL(url).hostname === 'vecchileiloes.com.br'), 'only Vecchi legacy requests ran');
  assert.deepEqual(observed, ['vecchileiloes.com.br'], 'Web aliases never start tenant observation');
  assert.deepEqual(blockedWrites, [[]], 'upsert receives no Web SKU/URL rows while Vecchi legacy remains enabled');
});

test('tenant adapters reject a cross-host final URL', async () => {
  await assert.rejects(collectCakeTenant('prosperarleiloes.com.br', 2, async url => ({
    status: 200, body: prosperarCatalog, headers: {}, url: url.replace('prosperarleiloes.com.br', 'other.example'),
  })), /redirect fora do tenant/);
});

test('strict tenant GET permits www alias only and reports the final URL without network access', async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  let redirectBodyCancelled = false;
  let rejectedRedirectBodyCancelled = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    assert.equal(init?.redirect, 'manual');
    if (requested.length === 1) return new Response(new ReadableStream({ cancel() { redirectBodyCancelled = true; } }), { status: 302, headers: { location: 'https://www.leiloesfederal.com.br/leilao/335' } });
    return new Response('fixture body', { status: 200 });
  }) as typeof fetch;
  try {
    const response = await fetchTenantText('https://leiloesfederal.com.br/', 'leiloesfederal.com.br', { gapMs: 0 });
    assert.equal(response.url, 'https://www.leiloesfederal.com.br/leilao/335');
    assert.equal(response.body, 'fixture body');
    assert.equal(redirectBodyCancelled, true);
    globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { rejectedRedirectBodyCancelled = true; } }), { status: 302, headers: { location: 'https://other.example/' } })) as typeof fetch;
    await assert.rejects(fetchTenantText('https://leiloesfederal.com.br/', 'leiloesfederal.com.br', { gapMs: 0 }), TenantScopeError);
    assert.equal(rejectedRedirectBodyCancelled, true);
  } finally { globalThis.fetch = original; }
});

console.log('target tenant contracts: Federal/Prosperar/Web fixtures, dedupe, schema/host guards, redirect-body cleanup OK');
