import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectMjLeiloes, mapHtmlAgendaLot } from '../src/connectors/htmlagenda.js';

const fixture = (name: string) => readFile(new URL(`../fixtures/htmlagenda/mj/${name}`, import.meta.url), 'utf8');
const home = await fixture('leiloes.html');
const event = await fixture('leilao-243.html');
const detail = await fixture('lote-1269.html');

const calls: string[] = [];
const collected = await collectMjLeiloes('mjleiloes.com.br', 88, undefined, (async (url: string) => {
  calls.push(url);
  const path = new URL(url).pathname;
  if (path === '/leiloes') return { status: 200, body: home, headers: {} };
  if (path === '/leiloes/238') return { status: 200, body: '<h1>Informática</h1>', headers: {} };
  if (path === '/leiloes/243') return { status: 200, body: event, headers: {} };
  if (path === '/leiloes/243' && new URL(url).searchParams.has('page')) return { status: 200, body: event, headers: {} };
  if (path.startsWith('/lote/1269/')) return { status: 200, body: detail, headers: {} };
  return { status: 404, body: '', headers: {} };
}) as any);

assert.ok(calls.includes('https://www.mjleiloes.com.br/leiloes/243?page=1'), 'observed pagination URL is followed');
assert.ok(!calls.some((url) => url.includes('/leiloes/125')), 'event visibly still being loted is not treated as a published catalog');
assert.equal(calls.filter((url) => url.includes('/leiloes/243')).length, 2, 'root and page=1 are both fetched and deduplicated by card signature');
assert.equal(calls.filter((url) => url.includes('/lote/1266/')).length, 0, 'explicit scrap lot is excluded before detail fetch');
assert.equal(collected.fetched, 2, 'two distinct observed lot cards');
assert.equal(collected.skipped, 1, 'the scrap card is discarded');
assert.equal(collected.lots.length, 1);

const renault = collected.lots[0];
assert.equal(renault.externalId, 'mjleiloes.com.br:1269');
assert.equal(renault.titleRaw, 'RENAULT MASTER JAEDI TUR ANO/MOD: 2014/2015, COMBUSTÍVEL; DIESEL, COR: BRANCO (DIR A DOCUMENTO)');
assert.equal(renault.assetType, 'veiculo');
assert.equal(renault.minBid, 7500);
assert.equal(renault.currentBid, null);
assert.equal(renault.status, 'aberto');
assert.equal(renault.auctionStartUtc?.toISOString(), '2026-10-13T13:00:00.000Z');
assert.equal(renault.auctionEndUtc?.toISOString(), '2026-11-04T13:00:00.000Z');
assert.equal(renault.sourceTz, 'America/Fortaleza');

const wrongId = detail.replace('"id":1269', '"id":1270');
assert.equal(mapHtmlAgendaLot('mjleiloes.com.br', 'https://www.mjleiloes.com.br/lote/1269/slug', wrongId), null,
  'detail payload must match the requested lot ID');

console.log('MJ contract: observed event/listing/detail, dedup, scrap exclusion and PHP lot payload OK');
