import assert from 'node:assert/strict';
import { parseSuporteOferta, ofertaLinks, eventoLinks, eventosAtivos, ofertaStatus } from '../src/connectors/suporte-oferta.js';
import { collectSuporteTenant } from '../src/connectors/suporteleiloes.js';
import type { TenantAttempt } from '../src/core/tenant-attempts.js';
import { CollectionCancellationError, withCollectionCancellation } from '../src/core/collection-cancellation.js';

const payload = (title = 'Lote 298 de terreno', tags = '[{"code":"imovel","name":"Imóvel"},{"code":"terreno","name":"Terreno"}]', itemStatus = '1', statusString = '') => `
<script>
var leilao = {"id":483,"aid":485,"dataProximoLeilao":{"date":"2026-10-15 10:00:00.000000","timezone":"America/Fortaleza"},"statusString":"Aberto para lances","leiloeiro":"Adilson Bento","vendaDireta":false};
var lote = {"id":841,"aid":877,"titulo":"${title}","status":${itemStatus}${statusString ? `,"statusString":"${statusString}"` : ''},"valorMinimo":"48340.63","valorAtual":"48340.63","valorIncremento":1000,"tags":${tags}};
</script>
<div id="lote-image-container"><img id="lote-image" src="https://static.suporteleiloes.com.br/abaleiloescombr/bens/841/arquivos/photo.jpg"></div><ul class="lote-thumbs"><li><a href="https://static.suporteleiloes.com.br/abaleiloescombr/bens/841/arquivos/thumb.jpg"></a></li></ul><main><img src="/bens/other-lot.jpg"><img src="/assets/logo.png"></main>`;
const host = 'abaleiloes.com.br';
const lot = parseSuporteOferta(payload(), host, '/oferta/leilao/imoveis/terreno/841/id-877/x');
assert.ok(lot);
assert.equal(lot.externalId, `${host}:oferta:877`);
assert.equal(parseSuporteOferta(payload(), `www.${host}`, '/id-877')?.externalId, lot.externalId);
assert.equal(lot.assetType, 'imovel');
assert.equal(lot.auctionStartUtc?.toISOString(), '2026-10-15T13:00:00.000Z');
assert.equal(lot.auctionEndUtc, null);
assert.equal(lot.minBid, 48340.63);
const marcoRealContract = `<script>
var leilao={"id":340,"statusString":"Aberto"};
var lote={"id":4195,"aid":3951,"titulo":"GM MERIVA 1.8 MPFI","status":1,"valorInicial":4000,"valorAtual":4600,"valorIncremento":200,"tags":[{"code":"veiculos"}]};
</script>`;
const marcoRealLot = parseSuporteOferta(marcoRealContract, 'marcotulioleiloes.com.br', '/oferta/leilao/4195/id-3951/meriva');
assert.equal(marcoRealLot?.externalId, 'marcotulioleiloes.com.br:oferta:3951');
assert.equal(marcoRealLot?.minBid, 4000);
assert.equal(marcoRealLot?.currentBid, 4600);
assert.equal(marcoRealLot?.bidIncrement, 200);
assert.equal(marcoRealLot?.status, 'aberto');
assert.deepEqual(lot.photos, [
  'https://static.suporteleiloes.com.br/abaleiloescombr/bens/841/arquivos/photo.jpg',
  'https://static.suporteleiloes.com.br/abaleiloescombr/bens/841/arquivos/thumb.jpg',
]);
assert.equal(parseSuporteOferta(payload('Lote 298', undefined, '1', 'Lote encerrado'), host, '/id-877')?.status, 'encerrado');
assert.equal(parseSuporteOferta(payload('Lote 298', undefined, '1', 'Lote vendido'), host, '/id-877')?.status, 'vendido');
assert.equal(ofertaStatus({ status: 8 }, { statusString: 'Aberto para lances' }, null, 0), 'sem_data');
assert.equal(parseSuporteOferta(payload('Carrinho Hot Wheels'), host, '/id-877'), null);
assert.equal(parseSuporteOferta(payload('Plotter digital para gráfica', '[]'), host, '/id-877'), null,
  'an unknown equipment title must not inherit classifyAsset’s default car');
assert.equal(parseSuporteOferta(payload().replace('"status":1', '"status":1,"descricao":"Veículo vendido como sucata"'), host, '/id-877'), null);
const vehicle = parseSuporteOferta(payload('JEEP/RENEGADE LNGTD AT', '[]'), host, '/id-877');
assert.equal(vehicle?.assetType, 'veiculo');
const machine = parseSuporteOferta(payload('Retroescavadeira Caterpillar', '[{"code":"maquinas","name":"Máquinas"}]'), host, '/id-877');
assert.equal(machine?.assetType, 'veiculo');
assert.equal(machine?.vehicleType, 'maquina');
assert.equal(ofertaLinks('<a href="/oferta/leilao/x">a</a>', host).length, 1);
assert.equal(eventoLinks('<a href="/leiloes/3">a</a>', host).length, 1);
assert.equal(eventosAtivos('<li class="isotope-item proximos"><a class="link-leilao" href="/leiloes/3"></a><span id="nm_statusmontagem">Aberto para lances</span></li><li class="isotope-item"><a class="link-leilao" href="/leiloes/4"></a><span id="nm_statusmontagem">Encerrado</span></li>', host).join(), `https://${host}/leiloes/3`);

// Offline end-to-end fallback: current /leiloes -> active event 483 -> offer, skipping closed event.
const activeList = `<html><script src="https://static.suporteleiloes.com.br/x.js"></script>
<li class="isotope-item proximos"><a class="link-leilao" href="/leiloes/483">483</a><span id="nm_statusmontagem">Aberto para lances</span><span id="nm_statusleilao">Online</span></li>
<li class="isotope-item"><a class="link-leilao" href="/leiloes/191">191</a><span id="nm_statusmontagem">Leilão encerrado</span></li></html>`;
const eventPage = `<script src="https://static.suporteleiloes.com.br/x.js"></script><form action="/leiloes/483?page=1"></form>
<a href="?page=2">Próxima</a><a href="/oferta/leilao/imoveis/terreno/841/id-877/teste">Lote</a>`;
const requested: string[] = [], responses: number[] = [], failures: string[] = [];
let ledgerState = '';
const observer = {
  start: async () => ({
    response: (status: number) => responses.push(status),
    failure: (kind = 'network') => failures.push(kind),
    finish: async (stats: any) => { ledgerState = failures.length || responses.some(s => s < 200 || s >= 300) ? 'failed' : stats.truncated ? 'partial' : 'completed'; },
  } as unknown as TenantAttempt),
};
const request = async (url: string) => {
  requested.push(url);
  if (url.endsWith('/leiloes')) return { status: 200, body: activeList };
  if (url.endsWith('/leiloes/483')) return { status: 200, body: eventPage };
  if (url.endsWith('/leiloes/483?page=2')) return { status: 200, body: `<a href="/oferta/leilao/imoveis/terreno/841/id-877/teste">Lote</a>` };
  if (url.includes('/oferta/')) return { status: 200, body: payload() };
  throw new Error(`unexpected request: ${url}`);
};
const result = await collectSuporteTenant(host, 10, undefined, observer, request as any);
assert.deepEqual(requested.map((url) => new URL(url).pathname + new URL(url).search), [
  '/leiloes', '/leiloes/483', '/leiloes/483?page=2', '/oferta/leilao/imoveis/terreno/841/id-877/teste',
]);
assert.equal(result.lots.length, 1);
assert.equal(result.lots[0].externalId, `${host}:oferta:877`);
assert.equal(result.lots[0].auctionStartUtc?.toISOString(), '2026-10-15T13:00:00.000Z');
assert.equal(result.lots[0].auctionEndUtc, null);
assert.ok((result.lots[0].photos?.length ?? 0) >= 1);
assert.deepEqual(failures, []);
assert.equal(ledgerState, 'completed');

// An expected /leiloes 404 can fall back to a valid active homepage without poisoning the ledger.
const fallbackResponses: number[] = [], fallbackFailures: string[] = [];
let fallbackState = '';
const fallbackObserver = { start: async () => ({
  response: (status: number) => fallbackResponses.push(status),
  failure: (kind = 'network') => fallbackFailures.push(kind),
  finish: async () => { fallbackState = fallbackFailures.length || fallbackResponses.some(s => s < 200 || s >= 300) ? 'failed' : 'completed'; },
} as unknown as TenantAttempt) };
const fallbackRequest = async (url: string) => url.endsWith('/leiloes')
  ? { status: 404, body: '' }
  : url.endsWith('/') ? { status: 200, body: `<script src="https://static.suporteleiloes.com.br/x.js"></script><a href="/oferta/leilao/imoveis/terreno/841/id-877/teste">Lote</a>` }
    : { status: 200, body: payload() };
const fallback = await collectSuporteTenant(host, 2, undefined, fallbackObserver, fallbackRequest as any);
assert.equal(fallback.lots.length, 1);
assert.deepEqual(fallbackResponses, [200, 200]);
assert.deepEqual(fallbackFailures, []);
assert.equal(fallbackState, 'completed');

// Marco's real card contract is `.flex-leiloes article`, not ABA's `.isotope-item`.
// This minimized fixture carries the 20 live offers observed on event 351.
const marcoHost = 'marcotulioleiloes.com.br';
const marcoListing = `<html><head><title>Agenda | Marco Tulio Leilões</title><script src="https://static.suporteleiloes.com.br/x.js"></script></head><section class="flex-leiloes">
<article><a href="/leiloes/351">Leilão 351</a><div class="button-leilao"><span class="leilao-online verde">Aberto para lances</span></div></article>
<article><a href="/leiloes/191">Leilão antigo</a><div class="button-leilao"><span class="leilao-online">Encerrado</span></div></article></section></html>`;
const marcoEvent = `<html><script src="https://static.suporteleiloes.com.br/x.js"></script><form action="/leiloes/351?page=1"></form>${Array.from({ length: 20 }, (_, i) =>
  `<a class="lote-image" href="/oferta/leilao/veiculos/camioneta/${4371 + i}/id-${4126 + i}/jeep-renegade">Oferta</a>`).join('')}</html>`;
const marcoRequests: string[] = [];
const marcoRequest = async (url: string) => {
  marcoRequests.push(url);
  if (url.endsWith('/leiloes')) return { status: 200, body: marcoListing };
  if (url.endsWith('/leiloes/351')) return { status: 200, body: marcoEvent };
  const ids = /\/(\d+)\/id-(\d+)\//.exec(url);
  if (ids) return { status: 200, body: `<script>
    var leilao = {"id":351,"aid":351,"dataProximoLeilao":{"date":"2026-10-20 10:00:00.000000","timezone":"America/Fortaleza"},"statusString":"Aberto para lances","leiloeiro":"Marco Tulio Montenegro Cavalcanti Dias"};
    var lote = {"id":${ids[1]},"aid":${ids[2]},"titulo":"JEEP/RENEGADE LNGTD AT","status":1,"tags":[],"valorMinimo":"22805.30","valorAtual":"16300.00"};
    </script><img id="lote-image" src="/bens/${ids[1]}/arquivos/foto.jpg">` };
  throw new Error(`unexpected Marco request: ${url}`);
};
const marcoResult = await collectSuporteTenant(marcoHost, 1200, undefined, undefined, marcoRequest as any);
assert.equal(marcoResult.fetched, 20);
assert.equal(marcoResult.lots.length, 20);
assert.equal(marcoResult.lots[0].externalId, `${marcoHost}:oferta:4126`);
assert.equal(marcoResult.lots[0].auctionStartUtc?.toISOString(), '2026-10-20T13:00:00.000Z');
assert.equal(marcoResult.lots[0].auctionEndUtc, null);
assert.ok((marcoResult.lots[0].photos?.length ?? 0) >= 1);
assert.ok(!marcoRequests.some((url) => url.endsWith('/leiloes/191')));
assert.equal(marcoRequests.filter((url) => url.includes('/oferta/')).length, 20);

let cancelledFinished = false;
const cancelObserver = { start: async () => ({
  response: () => assert.fail('cancelled before HTTP'), failure: () => {},
  finish: async () => { cancelledFinished = true; },
} as unknown as TenantAttempt) };
const controller = new AbortController();
controller.abort(new CollectionCancellationError('shutdown'));
await assert.rejects(withCollectionCancellation({ signal: controller.signal }, () =>
  collectSuporteTenant(host, 1, undefined, cancelObserver, request as any)), /coleta cancelada/);
assert.equal(cancelledFinished, true);
console.log('suporte-oferta: ok');
