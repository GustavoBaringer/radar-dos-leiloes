import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { collectSoleon, lerCards } from '../src/connectors/soleon.js';
import { mapHtmlAgendaLot, reviewedCatalogLotLinks, selectTenantPopulation } from '../src/connectors/htmlagenda.js';
import type { query } from '../src/core/db.js';

const fixture = (path: string) => readFile(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
const cards = async (path: string, host: string) => lerCards(cheerio.load(await fixture(path)), host);

assert.equal((await cards('soleon/tenant-scan/italo-1.html', 'italoleiloes.com'))[0].itemId, '8189');
assert.equal((await cards('soleon/tenant-scan/italo-2.html', 'italoleiloes.com'))[0].itemId, '8435');
assert.equal((await cards('soleon/tenant-scan/sn-1.html', 'snleiloes.com.br'))[0].itemId, '1280');
assert.equal((await cards('soleon/tenant-scan/construbem-2.html', 'construbemleiloes.com.br'))[0].itemId, '1898');
assert.equal((await cards('soleon/tenant-scan/sydney-2.html', 'sydneyleiloes.com.br'))[0].status, 'vendido');
assert.equal((await cards('soleon/tenant-scan/patiorocha-1.html', 'patiorochaleiloes.com.br'))[0].itemId, '10127');

const host = 'italoleiloes.com';
const pageFiles = new Map([
  ['/lotes/veiculo', 'soleon/tenant-scan/italo-2.html'],
  ['/lotes/imovel', 'soleon/tenant-scan/italo-1.html'],
  ['/lotes/diversos', 'soleon/tenant-scan/italo-3.html'],
]);
const fetchText = async (url: string) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.startsWith('/item/')) return { status: 200, body: '', headers: {} };
  const file = pageFiles.get(path);
  return { status: 200, body: file ? await fixture(file) : '', headers: {} };
};
const lookup = (async <T>(sql: string): Promise<T[]> => {
  if (sql.includes('FROM discovered_sites')) return [{ domain: host }] as T[];
  return [];
}) as typeof query;
const italo = await collectSoleon({ tenant: host, limit: 27 }, { fetchText: fetchText as any, query: lookup });
assert.equal(italo.fetched, 27, 'observed 20 + 4 + 3 cards traversed');
assert.ok(italo.lots.some((lot) => lot.externalId === 'italoleiloes.com:8189' && lot.assetType === 'imovel'));
assert.ok(italo.lots.some((lot) => lot.externalId === 'italoleiloes.com:8435' && lot.assetType === 'veiculo'));

const construbem = 'construbemleiloes.com.br';
const diverseRequests: string[] = [];
const construbemFetch = async (url: string) => {
  const parsed = new URL(url);
  diverseRequests.push(parsed.pathname);
  if (parsed.pathname === '/lotes/diversos') {
    const html = await fixture('soleon/tenant-scan/construbem-3.html');
    const $ = cheerio.load(html);
    return { status: 200, body: $.html($('div.lote').first()), headers: {} };
  }
  return { status: 200, body: '', headers: {} };
};
const noDiscovery = (async <T>(sql: string): Promise<T[]> => sql.includes('FROM lots') ? [] : []) as typeof query;
const rejectedOnly = await collectSoleon({ tenant: construbem, limit: 1 }, { fetchText: construbemFetch as any, query: noDiscovery });
assert.ok(diverseRequests.includes('/lotes/diversos'), 'verified unregistered manual tenant reaches its observed diverse route');
assert.equal(rejectedOnly.fetched, 1);
assert.equal(rejectedOnly.skipped, 1, 'generic diverse materials are excluded, not misclassified as vehicles');
assert.equal(rejectedOnly.lots.length, 0);

const sydney = 'sydneyleiloes.com.br';
const sydneyFetch = async (url: string) => {
  const parsed = new URL(url);
  if (parsed.pathname.startsWith('/item/')) return { status: 200, body: '', headers: {} };
  if (parsed.pathname === '/lotes/diversos') return { status: 200, body: await fixture('soleon/tenant-scan/sydney-2.html'), headers: {} };
  return { status: 200, body: '', headers: {} };
};
const sydneyRows = (async <T>(sql: string): Promise<T[]> => sql.includes('FROM discovered_sites') ? [{ domain: sydney }] as T[] : []) as typeof query;
const historic = await collectSoleon({ tenant: sydney, limit: 1 }, { fetchText: sydneyFetch as any, query: sydneyRows });
assert.equal(historic.lots[0]?.externalId, 'sydneyleiloes.com.br:384');
assert.equal(historic.lots[0]?.status, 'vendido', 'historic listing retains source status');

for (const [tenant, file] of [
  ['marcoantonioleiloeiro.com.br', 'marco'],
  ['dcmleiloes.com.br', 'dcm'],
] as const) {
  assert.deepEqual(selectTenantPopulation([], tenant), [tenant], 'manually reviewed tenant need not be in registry');
  const catalog = await fixture(`htmlagenda/suporteleiloes/${file}-leiloes_judiciais.html`);
  const links = reviewedCatalogLotLinks(catalog, `https://${tenant}`);
  assert.ok(links.some((url) => url === `https://${tenant}/lotes/10986`));
  assert.equal(new Set(links).size, links.length, 'duplicate links in server-rendered catalog are removed');
  const detail = await fixture(`htmlagenda/suporteleiloes/${file}-detail.html`);
  assert.equal(mapHtmlAgendaLot(tenant, `https://${tenant}/lotes/10986`, detail), null,
    'reduced snapshot without a complete linked payload is not treated as a complete detail');
  assert.equal(mapHtmlAgendaLot(tenant, `https://${tenant}/lotes/10986`, '<h1>LOTE C/BENFEITORIAS</h1>'), null,
    'unexpected detail schema without item category is rejected');
}

const linkedPayload = '<h1>LOTE C/BENFEITORIAS | ÁREA 350M²</h1><script>{"initialLote":{"id":10986,"lanceInicial":97500,"valorAvaliado":97500,"bem":{"tipoPai":"Imóveis"}},"related":{"id":1,"tipoPai":"Veículos","valorAvaliado":1}}</script>';
const linkedLot = mapHtmlAgendaLot('marcoantonioleiloeiro.com.br', 'https://marcoantonioleiloeiro.com.br/lotes/10986', linkedPayload);
assert.equal(linkedLot?.assetType, 'imovel');
assert.equal(linkedLot?.appraisal, 97500, 'appraisal belongs to initialLote matching requested ID');
assert.equal(linkedLot?.minBid, 97500);
assert.equal(linkedLot?.currentBid, null);
assert.equal(linkedLot?.status, 'sem_data', 'status is not fabricated from unsupported metadata');

const unrelatedMetadata = '<h1>Apartamento</h1><script>{"related":{"id":999,"tipoPai":"Imóveis","valorAvaliado":123456}}</script>';
const unrelatedLot = mapHtmlAgendaLot('unreviewed.example', 'https://unreviewed.example/lotes/10986', unrelatedMetadata);
assert.equal(unrelatedLot?.appraisal, null, 'related/menu metadata is not attributed to requested lot');
assert.equal(unrelatedLot?.sourceCategory, null, 'related/menu category is not attributed to requested lot');

const missingLinkedFields = '<h1>Apartamento</h1><script>{"initialLote":{"id":10986},"related":{"tipoPai":"Imóveis","valorAvaliado":123456}}</script>';
const missingFieldsLot = mapHtmlAgendaLot('unreviewed.example', 'https://unreviewed.example/lotes/10986', missingLinkedFields);
assert.equal(missingFieldsLot?.appraisal, null, 'related appraisal cannot fill absent field on requested lot');
assert.equal(missingFieldsLot?.sourceCategory, null, 'related category cannot fill absent field on requested lot');

const mislabeledPrice = mapHtmlAgendaLot('unreviewed.example', 'https://unreviewed.example/lotes/100',
  '<h1>Apartamento</h1><p>Lance atual: indisponível. Avaliação: R$ 97.500,00</p>');
assert.equal(mislabeledPrice?.minBid, null);
assert.equal(mislabeledPrice?.currentBid, null, 'valuation after an unavailable bid is not a current bid');
const labeledPrices = mapHtmlAgendaLot('unreviewed.example', 'https://unreviewed.example/lotes/101',
  '<h1>Apartamento</h1><p>Lance mínimo: R$ 12.500,00. Maior lance: R$ 14.000,00</p>');
assert.equal(labeledPrices?.minBid, 12500, 'accented minimum label is recognized');
assert.equal(labeledPrices?.currentBid, 14000, 'greater bid label maps to current bid');

// Synthetic page-aware pagination contract: duplicate IDs simulate overlap
// across page boundaries and between property/diverse categories.
const pageHtml = (lots: Array<{ id: number; title: string; description: string }>) => lots.map(({ id, title, description }) =>
  `<div class="lote"><h4>Lote ${id}</h4><a href="/item/${id}/detalhes"></a><h5>${title}</h5><div style="text-align: justify">${description}</div><div class="label_lote em_breve">Em Breve</div><div class="etiqueta">Lance Inicial</div><h4>R$ 1000</h4></div>`).join('');
const propertyPage1 = Array.from({ length: 30 }, (_, i) => ({ id: 10000 + i, title: `Casa ${i}`, description: 'Imóvel residencial' }));
const propertyPage2 = [propertyPage1[0], ...Array.from({ length: 29 }, (_, i) => ({ id: 10030 + i, title: `Casa página 2 ${i}`, description: 'Imóvel residencial' }))];
const diversePage1 = [propertyPage1[0], ...Array.from({ length: 29 }, (_, i) => ({ id: 20000 + i, title: `Compressor industrial ${i}`, description: 'Compressor industrial' }))];
const diversePage2 = [diversePage1[1], ...Array.from({ length: 29 }, (_, i) => ({ id: 20029 + i, title: `Compressor industrial página 2 ${i}`, description: 'Compressor industrial' }))];
const pageBodies = new Map([
  ['/lotes/imovel:1', pageHtml(propertyPage1)], ['/lotes/imovel:2', pageHtml(propertyPage2)],
  ['/lotes/diversos:1', pageHtml(diversePage1)], ['/lotes/diversos:2', pageHtml(diversePage2)],
]);
const paginationRequests: string[] = [];
const previousDomains = process.env.SOLEON_DOMAINS;
process.env.SOLEON_DOMAINS = 'focoleiloes.com.br';
let paginated;
try {
  paginated = await collectSoleon({ tenant: 'focoleiloes.com.br', limit: 200 }, {
    query: noDiscovery,
    fetchText: (async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/item/')) return { status: 200, body: '', headers: {} };
      paginationRequests.push(`${parsed.pathname}?page=${parsed.searchParams.get('page') ?? ''}`);
      const key = `${parsed.pathname}:${parsed.searchParams.get('page')}`;
      return { status: 200, body: pageBodies.get(key) ?? '', headers: {} };
    }) as any,
  });
} finally {
  if (previousDomains === undefined) delete process.env.SOLEON_DOMAINS;
  else process.env.SOLEON_DOMAINS = previousDomains;
}
assert.ok(paginationRequests.includes('/lotes/imovel?page=1') && paginationRequests.includes('/lotes/imovel?page=2'));
assert.ok(paginationRequests.includes('/lotes/diversos?page=1') && paginationRequests.includes('/lotes/diversos?page=2'));
assert.ok(paginationRequests.includes('/lotes/veiculo?page=1'), 'later category is visited after paginated routes');
assert.equal(paginated!.fetched, 117, 'overlaps across pages and categories count only once');
assert.equal(paginated!.lots.length, 117, 'pagination and category traversal continue below the global cap');
assert.equal(new Set(paginated!.lots.map((lot) => lot.externalId)).size, 117);
assert.equal(paginated!.lots.filter((lot) => lot.assetType === 'imovel').length, 59);
assert.equal(paginated!.lots.filter((lot) => lot.vehicleType === 'maquina').length, 58);

console.log('tenant domain contracts: fixture catalogs/details and isolated collection OK');
