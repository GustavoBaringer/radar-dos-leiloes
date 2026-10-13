import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { collectLeiloar, collectNasar, nasarDate, nasarLocal, parseNasarCards } from '../src/connectors/leiloar.js';
import { classifyAsset } from '../src/core/normalize.js';
import { withCollectionCancellation } from '../src/core/collection-cancellation.js';

const dir = new URL('../fixtures/leiloar/nasar/', import.meta.url);
const load = async (id: number) => {
  const f = JSON.parse(await readFile(new URL(`${id}.json`, dir), 'utf8'));
  assert.equal(f.status, 200);
  assert.match(f.url, /^https:\/\/www\.nasarleiloes\.com\.br\/externo\//);
  assert.match(f.capturedAtUtc, /Z$/);
  assert.equal(createHash('sha256').update(f.html).digest('hex'), f.sha256FixtureHtml);
  const $ = cheerio.load(f.html);
  assert.equal($(f.selector).length, f.count);
  return f;
};

const home = await load(3), event131 = await load(4), event76 = await load(5);
const $home = cheerio.load(home.html);
const eventUrls = $home('.card-leilao a[href*="/externo/leilao/"]').map((_, a) => $home(a).attr('href')).get();
assert.ok(eventUrls.includes('/externo/leilao/131'));
assert.ok(eventUrls.includes('/externo/leilao/76'));
const cards131 = parseNasarCards(event131.html, event131.url);
const cards76 = parseNasarCards(event76.html, event76.url);
assert.equal(cards131.length, 32);
assert.equal(cards76.length, 28);
assert.equal(cards131[0].id, '2706');
assert.equal(cards131[0].category, 'Máquinas e Equip. Pesados');
assert.equal(cards131[0].appraisal, 390000);
assert.equal(cards131[0].minBid, 390000);
assert.equal(cards131[0].currentBid, null);
assert.equal(new URL(cards131[0].url).pathname, '/externo/lote/2706/ponte-de-movimentacao-rolante-dupla-em-eusebio');
const property = cards76.find(c => c.id === '1905')!;
assert.ok(property);
assert.equal(property.category, 'Imóveis Diversos');
assert.equal(property.saleValue, 496080);
assert.equal(property.appraisal, null);
assert.equal(property.minBid, null);
assert.equal(property.currentBid, null);
assert.equal(classifyAsset(property.title, property.category).assetType, 'imovel');
const distinctLocations = ['1905', '1911', '1912'].map(id => nasarLocal(cards76.find(c => c.id === id)!.title)?.city);
assert.deepEqual(distinctLocations, ['São Paulo', 'São Caetano do Sul', 'Campinas']);
assert.equal(nasarLocal(cards131[0].title), null, 'event venue must not leak into an individual lot');
assert.equal(classifyAsset(cards131.find(c => c.id === '2708')!.title, cards131.find(c => c.id === '2708')!.category).assetType, 'outro');
assert.equal(new Set([...cards131, ...cards76].map(c => c.id)).size, 60);

const utc131 = nasarDate(event131.html), utc76 = nasarDate(event76.html);
assert.equal(utc131.date?.toISOString(), '2026-10-16T20:00:00.000Z');
assert.equal(utc131.rawDate, '16/10/2026 17:00:00');
assert.equal(utc131.suspiciousFuture, false);
assert.equal(utc76.date?.toISOString(), '2045-01-01T15:00:00.000Z');
assert.equal(utc76.rawDate, '01/01/2045 12:00:00');
assert.equal(utc76.suspiciousFuture, true);

const response = (body: string, status = 200) => ({ body, status, headers: new Headers(), url: '' });
const fakeNasarFetch = async (url: string) => {
  const path = new URL(url).pathname;
  if (path === '/externo/') return response(home.html);
  if (path === '/externo/leilao/131') return response(event131.html);
  if (path === '/externo/leilao/76') return response(event76.html);
  return response('', 404);
};
const mapped = await collectNasar('nasarleiloes.com.br', 60, undefined, fakeNasarFetch as any);
assert.equal(mapped.fetched, 60);
assert.equal(mapped.lots.filter(l => l.assetType !== 'outro').length, 51);
const mappedProperty = mapped.lots.find(l => l.externalId === 'nasarleiloes.com.br:1905')!;
assert.equal(mappedProperty.city, 'São Paulo');
assert.equal(mappedProperty.minBid, null);
assert.equal(mappedProperty.appraisal, null);
assert.equal((mappedProperty.raw as any).eventDateSuspiciousFuture, true);
assert.equal(mapped.lots.find(l => l.externalId.endsWith(':2706'))?.city, null);
const single = await collectLeiloar({ limit: 60 }, { domains: ['nasarleiloes.com.br'], query: async () => [], fetchText: fakeNasarFetch as any });
assert.equal(single.lots.length, 51);

const failedEvent = await collectNasar('nasarleiloes.com.br', 60, undefined, (async (url: string) => {
  const path = new URL(url).pathname;
  if (path === '/externo/') return response(home.html);
  if (path === '/externo/leilao/131') return response('', 503);
  if (path === '/externo/leilao/76') return response(event76.html);
  return response('', 404);
}) as any);
assert.match(failedEvent.note ?? '', /HTTP 503/);
assert.equal(failedEvent.httpStatus, 200);
assert.ok(failedEvent.lots.length > 0, 'later event is still collected after one failed event');

const controller = new AbortController();
await assert.rejects(withCollectionCancellation({ signal: controller.signal }, () => collectNasar('nasarleiloes.com.br', 60, undefined, (async (url: string) => {
  const path = new URL(url).pathname;
  if (path === '/externo/') return response(home.html);
  controller.abort(new Error('test deadline'));
  throw new Error('aborted request');
}) as any)), { name: 'CollectionCancellationError' });

const legacy = (host: string) => Array.from({ length: 10 }, (_, i) => `<div class="bem-card"><a class="bem-card-descricao" href="/lote/${host === 'before.example' ? 80000 : 90000}${i}">Veículo de teste ${host} ${i}</a><div class="bem-card-localizacao">Campinas, SP</div><div class="bem-card-status"><span class="badge">ABERTO</span></div></div>`).join('');
const urls: string[] = [];
const finishes: Array<{ host: string; returned: number; fetched: number; skipped: number }> = [];
const multi = await collectLeiloar({ limit: 30, observer: { start: async (host: string) => ({ response() {}, failure() {}, finish: async (stats: any) => { finishes.push({ host, returned: stats.returned, fetched: stats.fetched, skipped: stats.skipped }); } }) } as any }, {
  domains: ['before.example', 'nasarleiloes.com.br', 'after.example'],
  query: async () => [],
  fetchText: (async (url: string) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'nasarleiloes.com.br' || parsed.hostname === 'www.nasarleiloes.com.br') return fakeNasarFetch(`${parsed.origin}${parsed.pathname}`);
    return response(legacy(parsed.hostname));
  }) as any,
});
assert.equal(multi.lots.length, 30);
assert.ok(multi.lots.some(l => l.externalId.startsWith('before.example:')));
assert.ok(multi.lots.some(l => l.externalId.startsWith('nasarleiloes.com.br:')));
assert.ok(multi.lots.some(l => l.externalId.startsWith('after.example:')));
assert.ok(urls.some(url => url.includes('/externo/leilao/')));
assert.deepEqual(finishes.map(f => f.host), ['before.example', 'nasarleiloes.com.br', 'after.example']);
assert.ok(finishes[1].returned > 0 && finishes[1].fetched > 0, 'Nasar observer receives real per-tenant counts');
assert.match(multi.note ?? '', /listed events unvisited at budget/);

const invalidLinks = `<div class="card-bem"><a href="https://evil.example/externo/lote/1">bad host</a><div class="card-bem-descricao">Casa em Campinas/SP</div></div><div class="card-bem"><a href="javascript:/externo/lote/2">bad scheme</a><div class="card-bem-descricao">Casa em Campinas/SP</div></div><div class="card-bem"><a href="/lote/3">bad path</a><div class="card-bem-descricao">Casa em Campinas/SP</div></div>`;
assert.equal(parseNasarCards(invalidLinks, event76.url).length, 0);

console.log('NASAR offline contract: OK (60 cards, location/date/price guards, partial failures, cancellation, same-host paths, multi-tenant merge/budget)');
