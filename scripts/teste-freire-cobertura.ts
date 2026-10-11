import assert from 'node:assert/strict';
import { collectLeiloesFreire, leiloesfreire, lerCards, mapearLote, normalizarTenantFreire, relancarCancelamento, statusDe } from '../src/connectors/leiloesfreire.js';
import { CollectionCancellationError, withCollectionCancellation } from '../src/core/collection-cancellation.js';

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

// Full offline flow proves the seventh active event is reached and follows an actual page link.
const eventCard = (id: number, status = 'Aberto para Lances') => `<article class="single_product">
  <div class="leilao_titulo"><a href="https://www.leiloesfreire.com.br/leilao/${id}">Leilão ${id}</a></div>
  <div class="leilao_situacao">${status}</div></article>`;
const sevenEventHome = Array.from({ length: 7 }, (_, i) => eventCard(1180 + i)).join('') + eventCard(1190, 'Encerrado');
const seventhLot = article(31070, retroTitle, 'Aguardando Lance', '55.100,00');
const requested: string[] = [], failures: string[] = [];
let finish: any;
const observer = { async start() { return {
  response() {}, failure(kind: string) { failures.push(kind); }, finish(stats: any) { finish = stats; },
}; } } as any;
const request = async (url: string) => {
  requested.push(url);
  if (url.endsWith('/leiloes')) return { status: 200, body: sevenEventHome };
  if (url.endsWith('/leilao/1186')) return { status: 200, body: `12/12/2026 às 14:00 <a href="/leilao/1186?page=2">Próxima</a>` };
  if (url.endsWith('/leilao/1186?page=2')) return { status: 200, body: seventhLot };
  return { status: 200, body: '' };
};
const full = await collectLeiloesFreire({ limit: 20, observer }, request as any);
assert.ok(requested.includes('https://www.leiloesfreire.com.br/leilao/1186'), 'event number seven is fetched (no six-event cap)');
assert.ok(requested.includes('https://www.leiloesfreire.com.br/leilao/1186?page=2'), 'only an actual pagination href is followed');
assert.ok(!requested.includes('https://www.leiloesfreire.com.br/leilao/1190'), 'closed card is excluded before event request');
assert.equal(full.lots.length, 1);
assert.equal(full.lots[0].assetType, 'veiculo');
assert.equal(full.lots[0].vehicleType, 'maquina');
assert.equal(full.lots[0].status, 'agendado');
assert.equal(full.lots[0].auctionStartUtc?.toISOString(), '2026-12-12T17:00:00.000Z');
assert.equal(finish.truncated, false);
assert.deepEqual(failures, []);

let boundedFinish: any;
const manyEvents = Array.from({ length: 51 }, (_, i) => eventCard(1300 + i)).join('');
const bounded = await collectLeiloesFreire({ limit: 100, observer: { async start() { return {
  response() {}, failure() {}, finish(stats: any) { boundedFinish = stats; },
}; } } as any }, async (url) => url.endsWith('/leiloes')
  ? { status: 200, body: manyEvents }
  : { status: 200, body: '' } as any);
assert.equal(bounded.lots.length, 0);
assert.equal(boundedFinish.truncated, true, 'bounded event traversal reports omitted active events as partial');

const abortController = new AbortController();
const cancelLog: { failures: string[]; finished: boolean } = { failures: [], finished: false };
const cancelObserver = { async start() { return {
  response() {}, failure(kind: string) { cancelLog.failures.push(kind); }, finish() { cancelLog.finished = true; },
}; } } as any;
const cancelRequest = async (url: string) => {
  if (url.endsWith('/leiloes')) return { status: 200, body: eventCard(1200) };
  const error = new CollectionCancellationError('deadline'); abortController.abort(error); throw error;
};
await assert.rejects(withCollectionCancellation({ signal: abortController.signal }, () =>
  collectLeiloesFreire({ limit: 10, observer: cancelObserver }, cancelRequest as any)), CollectionCancellationError);
assert.deepEqual(cancelLog.failures, ['budget']);
assert.equal(cancelLog.finished, true, 'cancelled Freire attempt is finalized');

console.log('Leilões Freire: máquinas, controles, status e tenant inválido OK');
