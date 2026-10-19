import assert from 'node:assert/strict';
import { parseAlfaPage } from '../src/connectors/alfaleiloes.js';

// Card DOM captured from the public /leiloes/ listing (2026-10-14): selectors,
// two auction rounds, absolute/relative links and the real estate title shape.
const card = (id: string, title: string) => `<div class="home-leiloes-cards">
  <div class="card-image"><a href="/lote/${id}/publico/"><img src="/foto.webp"></a></div>
  <div class="card-content"><p>${title}</p></div>
  <div class="card-content-judicial"><p>JUDICIAL</p></div>
  <div class="card-lances"><p>1ª Praça 21/09/2026 às 14:00</p><span js-money>83170,32</span></div>
  <div class="card-lances"><p>2ª Praça 14/10/2026 às 14:00</p><span js-money>49902,19</span></div>
  <div class="card-status green"><p>Aberto</p></div>
</div>`;
const html = `${card('10650', 'Lima Duarte (MG) - Terreno no Bairro de Pinheiros com 179m²')}
  ${card('99999', 'Lote de peças para sucata')}
  <a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=5">5</a>`;
const parsed = parseAlfaPage(html, 'https://www.alfaleiloes.com/leiloes/', 20);
assert.equal(parsed.fetched, 2);
assert.equal(parsed.lots.length, 1);
assert.equal(parsed.lots[0].externalId, '10650');
assert.equal(parsed.lots[0].status, 'aberto');
assert.equal(parsed.lots[0].minBid, 49902.19);
assert.equal(parsed.lots[0].auctionEndUtc?.toISOString(), '2026-10-14T17:00:00.000Z');
assert.equal(parsed.outOfScope, 1);
assert.deepEqual(parsed.nextPages.map((url) => new URL(url).searchParams.get('page')), ['2', '5']);

const duplicateAcrossPages = new Set<string>();
assert.equal(parseAlfaPage(html, 'https://www.alfaleiloes.com/leiloes/?page=2', 20, duplicateAcrossPages).lots.length, 1);
assert.equal(parseAlfaPage(html, 'https://www.alfaleiloes.com/leiloes/?page=3', 20, duplicateAcrossPages).lots.length, 0);
