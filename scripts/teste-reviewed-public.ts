import assert from 'node:assert/strict';
import { collectGhvmPublic, collectPortalPublic, parseGhvmCard, parsePortalDetail } from '../src/connectors/reviewed-public.js';

const portalUrl = 'https://portaldosleiloes.com.br/lote/automovel-camionete-ford-ranger-limited-3-2';
const portalDetail = (id: number, status = 'Aberto para Lances') => `<!doctype html><html><head>
<link rel="canonical" href="${portalUrl}"><meta property="og:title" content="Automóvel Camionete Ford Ranger Limited 3.2">
<meta property="og:image" content="https://portaldosleiloes.com.br/photo.jpg"></head><body>
<script>self.__next_f.push([1,"{\\"loteId\\":${id},\\"valorInicial\\":150000,\\"dataEncerra\\":\\"2026-12-31T00:00:00-03:00\\",\\"statusLabel\\":\\"${status}\\",\\"linhas\\":[{\\"k\\":\\"Avaliação\\",\\"v\\":\\"R$ 150.000,00\\"},{\\"k\\":\\"Lance inicial\\",\\"v\\":\\"R$ 150.000,00\\"},{\\"k\\":\\"Incremento\\",\\"v\\":\\"R$ 200,00\\"}]} "])</script></body></html>`;

const mappedPortal = parsePortalDetail(portalUrl, portalDetail(4418), 'portaldosleiloes.com.br', 'Veículos');
assert.equal(mappedPortal?.externalId, 'portaldosleiloes.com.br:4418');
assert.equal(mappedPortal?.assetType, 'veiculo');
assert.equal(mappedPortal?.minBid, 150000);
assert.equal(mappedPortal?.bidIncrement, 200);
assert.equal(mappedPortal?.status, 'aberto');
assert.equal(parsePortalDetail(portalUrl, portalDetail(4418, 'Vendido'), 'portaldosleiloes.com.br', 'Veículos')?.status, 'vendido');
const harleyUrl = 'https://portaldosleiloes.com.br/lote/harley-davidson-flhp-road-king-police';
const harleyHtml = portalDetail(4417).replaceAll(portalUrl, harleyUrl).replaceAll('Automóvel Camionete Ford Ranger Limited 3.2', 'HARLEY-DAVIDSON / FLHP ROAD KING POLICE');
assert.equal(parsePortalDetail(harleyUrl, harleyHtml, 'portaldosleiloes.com.br', 'Veículos')?.vehicleType, 'moto');

const pages = new Map<string, string>([
  ['https://portaldosleiloes.com.br/leiloes?situacao=andamento', '<a href="/leilao/88-evento">Evento</a>'],
  ['https://portaldosleiloes.com.br/leilao/88-evento?page=1', '<section class="lei-ev-body"><a class="lei-lote" href="/lote/automovel-camionete-ford-ranger-limited-3-2">Venda DiretaVeículosAutomóvel Camionete Ford Ranger Limited 3.2Lance inicialR$ 150.000,00Detalhes</a><a href="/leilao/88-evento?page=2">2</a></section>'],
  ['https://portaldosleiloes.com.br/leilao/88-evento?page=2', '<section class="lei-ev-body"><a class="lei-lote is-inativo" href="/lote/ja-vendido">VendidoDiversosTanque em fibraLance inicial—Detalhes</a></section>'],
  [portalUrl, portalDetail(4418)],
  ['https://portaldosleiloes.com.br/lote/ja-vendido', portalDetail(2, 'Vendido')],
]);
const portalCalls: string[] = [];
const portalResult = await collectPortalPublic({ limit: 20 }, { fetchText: async (url) => {
  portalCalls.push(url);
  const body = pages.get(url);
  if (body === undefined) throw new Error(`unexpected URL ${url}`);
  return { status: 200, body, headers: {} };
} });
assert.equal(portalCalls.length, 4, 'discovers event pages and skips terminal lots without opening details');
assert.equal(portalResult.fetched, 2);
assert.equal(portalResult.skipped, 1);
assert.equal(portalResult.lots.length, 1);
assert.equal(portalResult.note?.includes('paginação concluída'), true);

const ghvmPage = `<div class="MuiPaper-root jss441"><a href="/oferta/galpao-comercial-com-2-pavimentos-e-396-m-de-area-construida-em-novo-horizonte-5023938"></a>
<p class="jss455">Galpão Comercial Com 2 Pavimentos E 396 M² De Área Construída Em Novo Horizonte</p>
<p>Cupira • Lote 1</p><p>465 Visitas</p><p>2ª leilão/praça</p><p>16/10 - 14:00</p><p>Inicial: R$ 348.497,60</p>
<img src="https://static.example.test/galpao.jpg"></div>`;
const mappedGhvm = parseGhvmCard('https://www.ghvmleiloes.com.br/?searchType=opened&pageNumber=1&pageSize=30&orderBy=endDate:asc', ghvmPage, 'ghvmleiloes.com.br')[0];
assert.equal(mappedGhvm?.assetType, 'imovel');
assert.equal(mappedGhvm?.propertyType, 'comercial');
assert.equal(mappedGhvm?.externalId, 'ghvmleiloes.com.br:galpao-comercial-com-2-pavimentos-e-396-m-de-area-construida-em-novo-horizonte-5023938');
assert.equal(mappedGhvm?.minBid, 348497.6);
assert.equal(mappedGhvm?.lotUrl, 'https://www.ghvmleiloes.com.br/oferta/galpao-comercial-com-2-pavimentos-e-396-m-de-area-construida-em-novo-horizonte-5023938');
assert.equal(mappedGhvm?.auctionStartUtc?.toISOString(), '2026-10-16T17:00:00.000Z');
assert.equal(parseGhvmCard('https://www.ghvmleiloes.com.br/h/imoveis', ghvmPage.replace('Inicial: R$ 348.497,60', 'Vendido'), 'ghvmleiloes.com.br', 'Imóveis').length, 0);

const ghvmCalls: string[] = [];
let renderedGhvm = false, closedGhvm = false;
const ghvmResult = await collectGhvmPublic({ limit: 10 }, { fetchText: async (url) => {
  ghvmCalls.push(url);
  if (url === 'https://www.ghvmleiloes.com.br') return { status: 200, body: '<html><div id="root"></div><script src="/app.js"></script></html>', headers: {} };
  throw new Error(`unexpected URL ${url}`);
}, renderPage: async (url) => { renderedGhvm = true; return { status: 200, body: ghvmPage, headers: {}, finalUrl: `${url}/?searchType=opened&pageNumber=1&pageSize=30&orderBy=endDate%3Aasc` }; }, close: async () => { closedGhvm = true; } });
assert.equal(ghvmResult.lots.length, 1);
assert.equal(ghvmResult.fetched, 1);
assert.equal(ghvmCalls.length, 1);
assert.equal(renderedGhvm, true);
assert.equal(closedGhvm, true);

await assert.rejects(() => collectPortalPublic({ limit: 1, tenant: 'attacker.example' }), /fora da população elegível/);
await assert.rejects(() => collectPortalPublic({ limit: 1 }, { fetchText: async () => ({ status: 403, body: '', headers: {} }) }), /HTTP 403/);
console.log('reviewed public connector checks passed');
