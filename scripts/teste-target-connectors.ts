import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Agent, MockAgent } from 'undici';
import { parseAlfaCards, parseAlfaPage } from '../src/connectors/alfaleiloes.js';
import { agendaLots, leilotech, lerDl } from '../src/connectors/leilotech.js';
import { lerCards, megaIndustrialPart, megaleiloes, nextMegaPages, tipoDeBem } from '../src/connectors/megaleiloes.js';
import { parseSuporteDetalhe } from '../src/connectors/suporte-oferta.js';
import { pool } from '../src/core/db.js';

const root = new URL('../fixtures/', import.meta.url);
const fixture = (name: string) => readFile(new URL(name, root), 'utf8');

test('Alfa catalog contract parses supported real-estate cards and deduplicates IDs', async () => {
  const html = await fixture('alfaleiloes/catalog-page1.html');
  const lots = parseAlfaCards(html, 'https://www.alfaleiloes.com/leiloes/?page=1');
  const lot = lots.find(item => item.externalId === '10742');
  assert.ok(lot);
  assert.match(lot.titleRaw, /Terreno no Bairro Gleba do Pêssego/i);
  assert.equal(lot.status, 'aberto');
  assert.equal(lot.minBid, 9901287.99);
  assert.equal(lot.auctionEndUtc?.toISOString(), '2026-10-15T17:00:00.000Z');
  assert.deepEqual(parseAlfaCards(html + html, 'https://www.alfaleiloes.com/leiloes/').map(item => item.externalId), lots.map(item => item.externalId));
  const bounded = parseAlfaPage(html, 'https://www.alfaleiloes.com/leiloes/?page=1', 2);
  assert.equal(bounded.fetched, 20);
  assert.equal(bounded.outOfScope, 4);
  assert.equal(bounded.overLimit, 14);
  assert.equal(bounded.skipped, 18);
  assert.deepEqual(bounded.lots.map(item => item.externalId), ['10650', '10738']);
  assert.deepEqual(bounded.nextPages.map(url => new URL(url).searchParams.get('page')), ['2', '3', '4', '5']);
  const duplicated = parseAlfaPage(html + html, 'https://www.alfaleiloes.com/leiloes/?page=1', 2);
  assert.equal(duplicated.duplicates, 18);
  assert.equal(duplicated.skipped, 38);
  assert.deepEqual(parseAlfaCards('<html><body>changed</body></html>', 'https://www.alfaleiloes.com/leiloes/'), []);
  assert.deepEqual(parseAlfaCards(html.replace('/lote/10742/', 'https://evil.example/lote/10742/'), 'https://www.alfaleiloes.com/leiloes/').filter(x => x.externalId === '10742'), []);
});

test('ArremataBem agenda selects only observed active lot links; detail status and BRL values parse', async () => {
  const html = await fixture('leilotech/arrematabem/agenda.html');
  const links = agendaLots(html, 'arrematabem.com.br');
  const lot = links.find(item => item.id === '1333');
  assert.ok(lot);
  assert.equal(links.length, 12);
  assert.ok(!links.some(item => item.url.includes('venda-direta') || item.url.includes('encerrados')));
  const dl = lerDl(await fixture('leilotech/arrematabem/detail-1333.html'));
  assert.equal(dl.status, 'ativo');
  assert.equal(dl['avaliação'], 'R$ 3065817.12');
  assert.deepEqual(agendaLots(html + html, 'arrematabem.com.br').map(item => item.id), links.map(item => item.id));
  assert.deepEqual(agendaLots('<html>schema changed</html>', 'arrematabem.com.br'), []);
});

test('Leilotech special Arremata flow does not abort the unchanged legacy tenant flow', async () => {
  const agenda = await fixture('leilotech/arrematabem/agenda.html');
  const detail = await fixture('leilotech/arrematabem/detail-1333.html');
  const active = agendaLots(agenda, 'arrematabem.com.br').find(item => item.id === '1333')!;
  const reducedAgenda = `<div id="v2-app"><a href="${new URL(active.url).pathname}">${active.title}</a></div>`;
  const agent = new MockAgent(); agent.disableNetConnect();
  const oldDispatch = Agent.prototype.dispatch, oldQuery = pool.query, oldFetch = globalThis.fetch, oldNow = Date.now;
  const oldTenantCount = process.env.LEILOTECH_TENANTS, oldLedger = process.env.TENANT_LEDGER_ENABLED;
  const calls: string[] = [];
  let inMockDispatch = false;
  (Agent.prototype as any).dispatch = function (opts: any, handler: any) {
    if (inMockDispatch) return oldDispatch.call(this, opts, handler);
    inMockDispatch = true;
    try { return agent.dispatch(opts, handler); }
    finally { inMockDispatch = false; }
  };
  (pool as any).query = async (sql: string) => ({ rows: sql.includes('discovered_sites') ? [{ domain: 'topoleiloes.com.br' }] : [] });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url.href);
    if (url.hostname !== 'arrematabem.com.br') throw new Error(`unexpected fetch host ${url.hostname}`);
    return new Response(url.pathname === '/agenda' ? reducedAgenda : detail, { status: 200 });
  }) as typeof fetch;
  const root = agent.get('https://topoleiloes.com.br');
  root.intercept({ path: '/agenda' }).reply(200, '<a href="/lote/2026/sample">Apartamento no Centro de Goiânia/GO</a>');
  root.intercept({ path: '/lote/2026/sample' }).reply(200, '<dl><dt>Status</dt><dd>ativo</dd></dl>');
  let time = oldNow(); Date.now = () => (time += 2000);
  process.env.LEILOTECH_TENANTS = '25'; process.env.TENANT_LEDGER_ENABLED = '0';
  try {
    const result = await leilotech.collect({ limit: 2 });
    assert.equal(result.lots.length, 2);
    assert.deepEqual(result.lots.map(item => item.externalId), ['arrematabem.com.br:1333', 'topoleiloes.com.br:2026']);
    assert.deepEqual(calls.map(url => new URL(url).pathname), ['/agenda', '/lote/1333/imovel-rural-em-guarinosgo']);
    assert.equal(result.lots[1].lotUrl, 'https://topoleiloes.com.br/lote/2026/sample');
  } finally {
    Agent.prototype.dispatch = oldDispatch; (pool as any).query = oldQuery;
    globalThis.fetch = oldFetch; Date.now = oldNow;
    if (oldTenantCount === undefined) delete process.env.LEILOTECH_TENANTS; else process.env.LEILOTECH_TENANTS = oldTenantCount;
    if (oldLedger === undefined) delete process.env.TENANT_LEDGER_ENABLED; else process.env.TENANT_LEDGER_ENABLED = oldLedger;
    await agent.close();
  }
});

test('Mega raw cards preserve IDs, BRL, status, UTC and only follow observed pagination', async () => {
  const vehicles = await fixture('megaleiloes/vehicles-page1.html');
  const vehicle = lerCards(vehicles, 'https://www.megaleiloes.com.br').find(item => item.id === '129402');
  assert.ok(vehicle);
  assert.match(vehicle.titulo, /Ford Fiesta/i);
  assert.equal(vehicle.preco, 15500);
  assert.equal(vehicle.status, 'Aberto para lances');
  assert.equal(vehicle.encerramento?.toISOString(), '2026-11-04T13:00:00.000Z');
  assert.deepEqual(nextMegaPages(vehicles, 'https://www.megaleiloes.com.br/veiculos', 'megaleiloes.com.br', '/veiculos'), [
    'https://www.megaleiloes.com.br/veiculos?pagina=2', 'https://www.megaleiloes.com.br/veiculos?pagina=3',
  ]);
  const industrial = lerCards(await fixture('megaleiloes/industrial-page1.html'), 'https://www.megaleiloes.com.br');
  const machine = industrial.find(item => item.id === '127653');
  assert.ok(machine);
  assert.match(machine.titulo, /Prensa Excêntrica/i);
  assert.equal(machine.preco, 16000);
  assert.equal(machine.encerramento?.toISOString(), '2026-10-14T13:00:00.000Z');
  const keepMachines = ['130253', '130255', '127417', '127418', '129619', '129621', '129625', '129626'];
  for (const id of keepMachines) {
    const card = industrial.find(item => item.id === id);
    assert.ok(card, `fixture ID ${id}`);
    assert.equal(tipoDeBem(card.url, card.titulo), 'veiculo', card.titulo);
    assert.equal(megaIndustrialPart(card.titulo), false, card.titulo);
  }
  for (const id of ['129613', '129616']) {
    const card = industrial.find(item => item.id === id);
    assert.ok(card, `fixture ID ${id}`);
    assert.equal(megaIndustrialPart(card.titulo), true, card.titulo);
  }
  assert.equal(tipoDeBem('https://www.megaleiloes.com.br/industrial/item', 'Lote Industrial'), 'outro', 'generic industrial titles are not promoted');
  assert.deepEqual(lerCards(vehicles.replace(/(<a class="card-title") href="[^"]+"/g, '$1'), 'https://www.megaleiloes.com.br'), [], 'no href means no emitted guessed lot URL');
  assert.deepEqual(nextMegaPages('<html>schema changed</html>', 'https://www.megaleiloes.com.br/industrial', 'megaleiloes.com.br', '/industrial'), []);
});

test('Mega preserves the existing /imoveis then /veiculos route and reports editorial mismatch as partial', async () => {
  const oldFetch = globalThis.fetch, oldNow = Date.now;
  const paths: string[] = [];
  const editorial = await fixture('megaleiloes/vehicles-page1.html');
  assert.ok(editorial, 'vehicle fixture exists');
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const body = url.pathname === '/imoveis' ? '<html><h1>Editorial, sem cards</h1></html>'
      : url.pathname === '/veiculos' ? editorial : '<html></html>';
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  let now = oldNow();
  Date.now = () => (now += 2000);
  try {
    const result = await megaleiloes.collect({ limit: 1 });
    assert.deepEqual(paths, ['/imoveis', '/veiculos']);
    assert.equal(result.lots.length, 1);
    assert.match(result.note ?? '', /\/imoveis respondeu sem cards.*parcial|cobertura parcial.*\/imoveis/i);
  } finally { globalThis.fetch = oldFetch; Date.now = oldNow; }
});

test('Vecchi existing Suporte parser returns tenant-qualified positive motorcycle without collecting bovines', async () => {
  const home = await fixture('suporteleiloes/vecchi/home.html');
  const detail = await fixture('suporteleiloes/vecchi/moto-2403.html');
  const lot = parseSuporteDetalhe(detail, 'vecchileiloes.com.br', 'https://www.vecchileiloes.com.br/eventos/leilao/1709/lote/2403/slug');
  assert.ok(lot);
  assert.equal(lot.externalId, 'vecchileiloes.com.br:2403');
  assert.match(lot.titleRaw, /HONDA CG\/150 FAN/i);
  assert.equal(lot.assetType, 'veiculo');
  assert.equal(lot.vehicleType, 'moto');
  assert.equal(lot.status, 'aberto');
  assert.equal(lot.minBid, 6000);
  assert.equal(lot.auctionEndUtc?.toISOString(), '2026-10-19T12:00:00.000Z');
  assert.match(home, /Bovinos/i);
  assert.ok(!lot.titleRaw.match(/boi|novilha|gado/i));
});

console.log('alfa/leilotech/mega/vecchi fixture contracts: OK');
