import assert from 'node:assert/strict';
import { leiloesfreire, lerCards, mapearLote, normalizarTenantFreire, relancarCancelamento, statusDe } from '../src/connectors/leiloesfreire.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';

const article = (id: number, title: string, status: string, price: string, image = '/retro.jpg') => `
<article class="single_product">
 <img src="${image}">
 <div class="leilao_titulo">${title}</div>
 <div class="leilao_situacao status">${status}</div>
 <span class="current_price">R$ ${price}</span>
 <a href="https://www.leiloesfreire.com.br/leilao/lote/${id}">${title}</a>
</article>`;

const retroTitle = 'RETROESCAVADEIRA XCMG XT870B CABINADA, ANO 2015, COR AMARELA, COMBUS DIESEL.';
const retro = lerCards(article(31069, retroTitle, 'Em disputa', '55.100,00'))[0];
assert.ok(retro);
const dataEvento = new Date('2026-10-08T23:00:00-03:00');
const mappedRetro = mapearLote(retro, '1183', dataEvento);
assert.equal(mappedRetro?.assetType, 'veiculo');
assert.equal(mappedRetro?.vehicleType, 'maquina');
assert.equal(mappedRetro?.status, 'aberto');
assert.equal(mappedRetro?.minBid, 55100);
assert.deepEqual(mappedRetro?.photos, ['/retro.jpg']);
assert.equal(mappedRetro?.auctionStartUtc?.toISOString(), dataEvento.toISOString());
assert.equal(mappedRetro?.auctionEndUtc?.toISOString(), dataEvento.toISOString());

const waiting = lerCards(article(10, 'Casa residencial em Maceió/AL', 'Aguardando Lance', '18.000,00'))[0];
assert.equal(mapearLote(waiting, '1184', null)?.assetType, 'imovel');
assert.equal(mapearLote(waiting, '1184', null)?.propertyType, 'casa');
assert.equal(statusDe('Aguardando Lance'), 'agendado');
assert.equal(statusDe('Em disputa'), 'aberto');

const car = lerCards(article(11, 'HONDA CIVIC LXS 2010/2011', 'Em disputa', '40.000,00'))[0];
assert.equal(mapearLote(car, '1183', null)?.assetType, 'veiculo');
assert.equal(mapearLote(car, '1183', null)?.vehicleType, 'carro');
const collectible = mapearLote(lerCards(article(12, 'Miniatura Hot Wheels Volkswagen Golf', 'Encerrado', '100,00'))[0], '1183', null);
assert.equal(collectible?.assetType, 'outro');
assert.equal(mapearLote(lerCards(article(13, 'Motor avulso de automóvel', 'Em disputa', '500,00'))[0], '1183', null), null);
assert.equal(lerCards(article(31069, retroTitle, 'Em disputa', '55.100,00').repeat(2)).length, 1);

assert.equal(normalizarTenantFreire(), null);
assert.equal(normalizarTenantFreire(' WWW.LeiloesFreire.com.br. '), 'leiloesfreire.com.br');
assert.throws(() => normalizarTenantFreire('outro-leiloeiro.com.br'));
assert.throws(() => normalizarTenantFreire(''));
let starts = 0;
await assert.rejects(leiloesfreire.collect({
  limit: 10,
  tenant: 'outro-leiloeiro.com.br',
  observer: { async start() { starts++; throw new Error('não deveria iniciar'); } },
}), /fora da população/);
assert.equal(starts, 0, 'tenant inválido é recusado antes de iniciar observer ou fazer HTTP');
assert.throws(() => relancarCancelamento(new CollectionCancellationError('deadline')), { name: 'CollectionCancellationError' });

console.log('Leilões Freire: máquinas, controles, status e tenant inválido OK');
