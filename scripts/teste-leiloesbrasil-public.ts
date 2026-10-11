import assert from 'node:assert/strict';
import {
  candidateFromRow, parseAuctionDate, parseBrazilianMoney, parseCatalogResponse, parseDetail,
} from '../src/connectors/leiloesbrasil-public.js';

const rows = (ids: string[]) => JSON.stringify({
  total: ids.length, totalLotesEncontrados: `${ids.length} lotes encontrados`,
  dados: ids.map((id, i) => `<tr class="js_lote" data-rowid="${id}" rel="6180/onlinelb/leilao/03-11-2026/${id}/lote/00${i + 1}"><td></td><td>ID Bem: 147640</td><td></td><td>MMC/200 TRITON</td><td></td><td class="js_dataLocalLeilao">03/11/2026 - 10h00<div><a title="Prefeitura de Cavalcante/GO"></a></div></td></tr>`).join(''),
});

const firstPage = parseCatalogResponse(rows(['191463', '191443']), 'veiculos');
const secondPage = parseCatalogResponse(rows(['191463']), 'veiculos');
const seen = new Set<string>();
const unique = [...firstPage, ...secondPage].filter((item) => !seen.has(item.id) && !!seen.add(item.id));
assert.deepEqual(unique.map((item) => item.id), ['191463', '191443']); // cross-page duplicate dedupe
assert.equal(parseCatalogResponse(JSON.stringify({ total: 0, totalLotesEncontrados: '0 lotes encontrados', dados: '' }), 'materiais').length, 0); // terminal empty category
assert.throws(() => parseCatalogResponse('{"total":1}', 'veiculos'), /Unknown.*schema/);
assert.equal(candidateFromRow({ ...firstPage[0], route: '/lote/191463' }), null); // non-catalog links aren't candidates

const vehicle = parseDetail(`<meta name="og:title" content="L - MMC/200 TRITON GX CAB.DUPA 3.2 DIESE"><meta name="description" content="Leilões Brasil | Gestora de Leilões - MMC/200 TRITON GX CAB.DUPA 3.2 DIESE"><span id="pregao-detalhe">Liberado Leilão</span><span class="lance-minimo">5.500,00</span><p>Avaliação: R$ 28.270.000,00</p><img src="/tmp/veiculo.jpg" alt="Foto 1 - Lote 9">`, firstPage[0], Date.parse('2026-10-11T12:00:00-03:00'))!;
assert.equal(vehicle.titleRaw, 'MMC/200 TRITON GX CAB.DUPA 3.2 DIESE');
assert.equal(vehicle.assetType, 'veiculo');
assert.equal(vehicle.minBid, 5500);
assert.equal(vehicle.auctionStartUtc?.toISOString(), '2026-11-03T13:00:00.000Z');
assert.equal(vehicle.photos[0], 'https://www.leiloesbrasil.com.br/tmp/veiculo.jpg');

const propertyCandidate = { ...firstPage[1], category: 'judiciais', dateText: '20/10/2026 - 15h30' };
const property = parseDetail(`<meta name="description" content="Leilões Brasil | Gestora de Leilões - 202605000001 - GOIANIA/GO - GALPAO COMERCIAL - Hospital Santa Genoveva"><span id="pregao-detalhe">Liberado Leilão</span><span class="lance-minimo">14.135.000,00</span><p>Avaliação: R$ 28.270.000,00</p>`, propertyCandidate, Date.parse('2026-10-11T12:00:00-03:00'))!;
assert.equal(property.assetType, 'imovel');
assert.equal(property.minBid, 14135000);
assert.equal(property.appraisal, 28270000);
assert.throws(() => parseDetail(`<meta name="og:title" content="Title"><span id="pregao-detalhe">Unknown state</span>`, firstPage[0]), /Unknown.*status/);
assert.equal(parseBrazilianMoney('R$ 14.135.000,00'), 14135000);
assert.equal(parseAuctionDate('20/10/2026 - 15h30')?.toISOString(), '2026-10-20T18:30:00.000Z');

console.log('leiloesbrasilpublic fixtures passed');
