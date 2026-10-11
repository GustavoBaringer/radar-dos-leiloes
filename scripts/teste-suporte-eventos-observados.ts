import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectDiscoveredTenant } from '../src/connectors/suporteleiloes.js';
import { parseSuporteDetalhe, parseSuporteOferta } from '../src/connectors/suporte-oferta.js';

const fixture = async (name: string) => readFile(new URL(`../src/connectors/fixtures/suporte-${name}.html`, import.meta.url), 'utf8');
const [pbEvent, pbDetail, colossoEvent, colossoDetail, atl, vlSchema] = await Promise.all([
  fixture('pb'), fixture('pb-lote'), fixture('colosso'), fixture('colosso-lote'), fixture('atl'), fixture('vl-schema'),
]);
const host = 'leiloespb.com.br';
const dynamicEvent = 'https://leiloespb.com.br/eventos/leilao/987654/dinamico';
const dynamicLot = 'https://leiloespb.com.br/eventos/leilao/dinamico/lote/44200/renault-kwid-intense-1-0-12v-5p-mec-flex-2022-2023';
const rewrittenEvent = `<script src="https://static.suporteleiloes.com.br/leiloespbcombr/x.js"></script><h1>Evento dinâmico</h1>
  <article class="lote-main bem-index-44200 lote-main-status-1"><a href="${dynamicLot}">Lote</a></article><a href="?page=2">Próxima</a>`;
const homepage = `<script src="https://static.suporteleiloes.com.br/leiloespbcombr/x.js"></script><a href="${dynamicEvent}">Evento dinâmico</a>`;
const responses = new Map<string, { status: number; body: string }>([
  ['https://leiloespb.com.br/', { status: 200, body: homepage }],
  [dynamicEvent, { status: 200, body: rewrittenEvent }],
  [`${dynamicEvent}?page=2`, { status: 200, body: rewrittenEvent }],
  [dynamicLot, { status: 200, body: pbDetail }],
]);
const request = async (url: string) => responses.get(url) ?? { status: 404, body: '' };
let observedResponses = 0, observedFinishes = 0;
let eventPagesFetched = 0;
const observer = { start: async () => ({ response: () => observedResponses++, failure: () => {}, finish: async () => { observedFinishes++; } }) } as any;
const result = await collectDiscoveredTenant(host, 2, undefined, observer, (async (url: string) => {
  if (url === dynamicEvent || url === `${dynamicEvent}?page=2`) eventPagesFetched++;
  return request(url);
}) as any);
assert.equal(result.lots.length, 1);
assert.equal(result.lots[0].externalId, 'leiloespb.com.br:44200');
assert.ok(result.lots[0].titleRaw.includes('RENAULT'));
assert.equal(result.lots[0].status, 'aberto');
assert.equal(result.fetched, 1); // one unique lot despite source-page duplicate
assert.equal(eventPagesFetched, 2);
assert.ok(observedResponses >= 1);
assert.equal(observedFinishes, 1);
const preservedIdentity = await collectDiscoveredTenant(host, 1, undefined, undefined, request as any, async () => '44200');
assert.equal(preservedIdentity.lots[0]?.externalId, '44200'); // existing URL identity wins over host:id
const collisionBlocked = await collectDiscoveredTenant(host, 1, undefined, undefined, request as any, async () => ({ collision: true }));
assert.equal(collisionBlocked.lots.length, 0);
assert.equal(collisionBlocked.skipped, 1);
assert.equal(collisionBlocked.truncated, true);

const hondaScrip = `<script>var leilao={"id":77,"statusString":"Aberto"};var lote={"id":91,"aid":92,"titulo":"Honda Civic","status":1,"valorInicial":1000,"valorAtual":0,"descricao":"","observacao":"Veículo vendido como sucata","tags":[]};</script>`;
assert.equal(parseSuporteOferta(hondaScrip, host, '/oferta/leilao/91/id-92/honda'), null);
assert.equal(parseSuporteDetalhe(hondaScrip, host, '/eventos/leilao/e/lote/91/honda'), null);
assert.equal(parseSuporteOferta(hondaScrip, host, '/oferta/leilao/91/id-92/honda') ?? parseSuporteDetalhe(hondaScrip, host, '/eventos/leilao/e/lote/91/honda'), null,
  'the fallback parser must not resurrect a lot rejected from aggregated condition text');
const hondaTagScrip = hondaScrip.replace('"observacao":"Veículo vendido como sucata"', '"observacao":""').replace('"tags":[]', '"tags":[{"code":"sucata"}]');
assert.equal(parseSuporteOferta(hondaTagScrip, host, '/oferta/leilao/91/id-92/honda'), null);
assert.equal(parseSuporteDetalhe(hondaTagScrip, host, '/eventos/leilao/e/lote/91/honda'), null);
const hondaPartTags = `<script>var leilao={"id":77,"statusString":"Aberto"};var lote={"id":91,"aid":92,"titulo":"Honda Civic","status":1,"valorInicial":1000,"valorAtual":0,"tags":[{"code":"retrovisor"},{"name":"motor parcial"}]};</script>`;
assert.equal(parseSuporteOferta(hondaPartTags, host, '/oferta/leilao/91/id-92/honda'), null);
assert.equal(parseSuporteOferta(hondaPartTags, host, '/oferta/leilao/91/id-92/honda') ?? parseSuporteDetalhe(hondaPartTags, host, '/eventos/leilao/e/lote/91/honda'), null,
  'part tags rejected by oferta must remain rejected after detail fallback');

// The event title, not its convenient numeric URL, excludes the known training catalog.
let requestedTraining = false;
const trainingCollector = await collectDiscoveredTenant(host, 3, undefined, undefined, (async (url: string) => {
  if (url.endsWith('/')) return { status: 200, body: `<script src="https://static.suporteleiloes.com.br/x.js"></script><a href="/eventos/leilao/402/treino-de-leilao">evento</a>` };
  if (url.includes('/eventos/')) { requestedTraining = true; return { status: 200, body: '<title>TREINO DE LEILÃO</title>' }; }
  return { status: 404, body: '' };
}) as any);
assert.equal(trainingCollector.lots.length, 0);
assert.equal(trainingCollector.truncated, true);
assert.ok(requestedTraining);

// A catalogue with a failed reachable page is partial, not a complete empty result.
const failed = await collectDiscoveredTenant(host, 3, undefined, undefined, (async (url: string) =>
  url.endsWith('/') ? { status: 200, body: homepage } : { status: 503, body: '' }) as any);
assert.equal(failed.lots.length, 0);
assert.equal(failed.truncated, true);
assert.match(failed.note ?? '', /parcial/i);

const colossoUrl = 'https://colossoleiloes.com.br/eventos/leilao/leilao-trt13-pb/lote/623/maquina';
assert.equal(parseSuporteDetalhe(colossoDetail, 'colossoleiloes.com.br', colossoUrl)?.vehicleType, 'maquina',
  'machine is accepted only when the existing classifier recognizes it');
const plotter = '<script>var lote={"id":596,"active":true,"deleted":false,"descricao":"Uma (01) Plotter digital, Marca Visutec, modelo V1800","status":1,"valorInicial":18000,"leilao":{"id":83,"praca":2,"data2":{"date":"2026-10-30 10:00:00.000000"}}};</script>';
assert.equal(parseSuporteDetalhe(plotter, 'colossoleiloes.com.br', 'https://colossoleiloes.com.br/eventos/leilao/leilao-trt13-pb/lote/596/plotter', 'Outros materiais'), null);
assert.ok(colossoEvent.includes('ISA SAZZI'));
const colossoLot = parseSuporteDetalhe(colossoDetail, 'colossoleiloes.com.br', colossoUrl);
assert.equal(colossoLot?.auctionStartUtc?.toISOString(), '2026-10-30T13:00:00.000Z');
assert.equal(colossoLot?.auctionEndUtc, null); // stale 15 September item deadline is not current

const atlUrl = 'https://atlanticoleiloes.com.br/eventos/leilao/terreno-em-alto-parnaiba-ma/lote/1025/imovel-urbano-com-10-002-60-m-em-alto-parnaiba-ma';
const atlLot = parseSuporteDetalhe(atl, 'atlanticoleiloes.com.br', atlUrl);
assert.ok(atlLot);
assert.equal(atlLot.externalId, 'atlanticoleiloes.com.br:1025');
assert.equal(atlLot.assetType, 'imovel');
assert.equal(atlLot.status, 'sem_data');
assert.equal(atlLot.auctionStartUtc?.toISOString(), '2026-10-14T13:00:00.000Z');
assert.equal(atlLot.auctionEndUtc, null); // stale item close date predates active plaza
assert.ok(atlLot.minBid && atlLot.appraisal);
const vlLot = parseSuporteDetalhe(vlSchema, 'vlleiloes.com.br', 'https://vlleiloes.com.br/eventos/leilao/424/lote/11412/terreno');
assert.ok(vlLot);
assert.equal(vlLot.externalId, 'vlleiloes.com.br:11412');
assert.match(vlLot.titleRaw, /terreno próprio nº 35/i);
assert.equal(vlLot.auctionStartUtc?.toISOString(), '2026-10-13T13:00:00.000Z');
assert.equal(vlLot.auctionEndUtc?.toISOString(), '2026-10-13T13:03:00.000Z');
assert.equal(vlLot.status, 'aberto');
const vlDynamicHome = '<script src="https://static.suporteleiloes.com.br/vlleiloescombr/x.js"></script><a href="/eventos/leilao/991/new-event">event</a>';
const vlEvent = '<script src="https://static.suporteleiloes.com.br/vlleiloescombr/x.js"></script><h1>Terreno</h1><a href="/eventos/leilao/new-event/lote/11412/terreno">Lote</a>';
const vlDynamic = await collectDiscoveredTenant('vlleiloes.com.br', 1, undefined, undefined, (async (url: string) => {
  if (url.endsWith('/')) return { status: 200, body: vlDynamicHome };
  if (url.endsWith('/eventos/leilao/991/new-event')) return { status: 200, body: vlEvent };
  if (url.endsWith('/lote/11412/terreno')) return { status: 200, body: vlSchema };
  return { status: 404, body: '' };
}) as any);
assert.equal(vlDynamic.lots[0]?.externalId, 'vlleiloes.com.br:11412');
assert.ok(pbEvent.includes('page=2') && pbEvent.includes('44200'));
console.log('suporte eventos observados: ok');
