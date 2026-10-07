import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

// Install a Node module hook before loading connectors; only their exact ./http.js
// imports are replaced. The fixture fails closed for every unconfigured URL.
// @ts-expect-error local test fixture has no declaration file
const httpHook = await import('./fixtures/tenant-http-hook.mjs');
httpHook.installTenantHttpHook();

const [{ vlance }, { leiloar }, { sishp }] = await Promise.all([
  import('../src/connectors/vlance.js'),
  import('../src/connectors/leiloar.js'),
  import('../src/connectors/sishp.js'),
]);

const queryOriginal = pg.Pool.prototype.query;
const requests: Array<{ url: string; method?: string }> = [];
let routeFixture: (url: URL, method?: string) => { status: number; body: string } | Promise<{ status: number; body: string }>;

httpHook.setTenantHttpFixture(async (rawUrl: string, opts: { method?: string }) => {
  const url = new URL(rawUrl);
  requests.push({ url: rawUrl, method: opts.method });
  if (!routeFixture) throw new Error(`unconfigured fixture request ${url.host}${url.pathname}`);
  const response = await routeFixture(url, opts.method);
  return { ...response, headers: {} };
});

function setTenants(domain: string | null) {
  pg.Pool.prototype.query = function (sql: string) {
    const rows = domain && sql.includes(`platform='${sql.includes("platform='leiloar'") ? 'leiloar' : sql.includes("platform='sishp'") ? 'sishp' : 'vlance'}'`)
      ? [{ domain }]
      : [];
    return Promise.resolve({ rows }) as any;
  } as any;
}

function observerLog() {
  const attempts: Array<{ domain: string; statuses: number[]; failures: string[]; stats?: any }> = [];
  return {
    attempts,
    observer: {
      async start(domain: string) {
        const row = { domain, statuses: [] as number[], failures: [] as string[], stats: undefined as any };
        attempts.push(row);
        return {
          response(status: number) { row.statuses.push(status); },
          failure(kind: 'network' | 'parser' = 'network') { row.failures.push(kind); },
          async finish(stats: any) { row.stats = stats; },
        };
      },
    },
  };
}

const vlanceItem = (title: string) => ({ lote_id: 'l-1', leilao_id: 'a-1', nm_titulo_lote: title, nm_url_leiloeiro: 'fixture.invalid' });
const leiloarHtml = '<p>Exibindo 1 de 1 resultados</p><div class="bem-card"><div class="bem-card-descricao"><a href="/lote/31">Toyota Corolla 2019</a></div><div class="bem-card-localizacao">Campinas, SP</div><div class="bem-card-status"><span class="badge">Aberto</span></div><div class="bem-card-avaliacao"><h5>R$ 50.000</h5></div><div class="bem-card-lance"><h4>R$ 20.000</h4><span>Mínimo</span></div></div>';
const sishpCards = '<div id="cul81"><div class="lote-nome"><span>Toyota Corolla 2020</span></div><div>Avaliação:</span><span>R$ 50.000</span><div>Lance mínimo:</span><span>R$ 20.000</span></div>';

test('real V-Lance collector parses fixture, observes response and stops at global limit', async () => {
  setTenants('fixture.invalid');
  requests.length = 0;
  routeFixture = (url) => {
    assert.equal(url.hostname, 'www.leiloescentrooeste.com.br'); // fixed official tenant remains first
    assert.equal(url.pathname, '/core/api/get-lotes');
    return { status: 200, body: JSON.stringify({ items: [vlanceItem('Toyota Corolla 2019'), vlanceItem('Honda Civic 2020')] }) };
  };
  const log = observerLog();
  const result = await vlance.collect({ limit: 1, assetTypes: ['veiculo'], observer: log.observer });
  assert.equal(result.lots.length, 1);
  assert.equal(result.lots[0].titleRaw, 'Toyota Corolla 2019');
  assert.deepEqual(requests.map((r) => r.url), ['https://www.leiloescentrooeste.com.br/core/api/get-lotes?tipo=1&qtd_por_pagina=5000']);
  assert.equal(log.attempts.length, 1); // no later tenant start after global limit
  assert.deepEqual(log.attempts[0].statuses, [200]);
  assert.deepEqual(log.attempts[0].stats, { fetched: 2, skipped: 0, returned: 1, truncated: true });
});

test('real Leiloar parser observes uncached and cached base HTTP accurately', async () => {
  setTenants('leiloar-fixture.invalid');
  requests.length = 0;
  routeFixture = (url) => {
    assert.equal(url.hostname, 'leiloar-fixture.invalid');
    return { status: 200, body: leiloarHtml };
  };
  const first = observerLog();
  const result1 = await leiloar.collect({ limit: 20, observer: first.observer });
  assert.equal(result1.lots.length, 1);
  assert.equal(result1.lots[0].externalId, 'leiloar-fixture.invalid:31');
  assert.equal(first.attempts[0].statuses.length, 2); // base probe + listing fetch
  assert.deepEqual(first.attempts[0].stats, { fetched: 1, skipped: 0, returned: 1, truncated: false });

  requests.length = 0;
  const cached = observerLog();
  await leiloar.collect({ limit: 20, observer: cached.observer });
  assert.equal(requests.length, 1); // cached base path contributes no fake response
  assert.deepEqual(cached.attempts[0].statuses, [200]);
  assert.deepEqual(cached.attempts[0].stats, { fetched: 1, skipped: 0, returned: 1, truncated: false });
});

test('real SISHP collector parses homepage, event, and lot fixtures', async () => {
  setTenants('sishp-fixture.invalid');
  requests.length = 0;
  routeFixture = (url) => {
    if (url.pathname === '/') return { status: 200, body: '<a href="leilao.php?idLeilao=7">Evento</a>' };
    if (url.pathname === '/leilao.php') return { status: 200, body: sishpCards };
    if (url.pathname === '/lote.php') return { status: 200, body: '<div class="text-uppercase font-weight-bold w-100 back-1">Aberto</div>' };
    throw new Error(`unexpected SISHP route ${url.pathname}`);
  };
  const log = observerLog();
  const result = await sishp.collect({ limit: 5, observer: log.observer });
  assert.equal(result.lots.length, 1);
  assert.equal(result.lots[0].externalId, '81');
  assert.deepEqual(log.attempts[0].statuses, [200, 200, 200]);
  assert.deepEqual(log.attempts[0].stats, { fetched: 1, skipped: 0, returned: 1, truncated: false });
});

test('first probe failure, fallback base, and parser exceptions are reflected on real collector attempts', async () => {
  setTenants('network-fixture.invalid');
  requests.length = 0;
  routeFixture = (url) => {
    if (url.pathname === '/bens/pesquisaAvancada') throw new Error('fixture network outage');
    if (url.pathname === '/externo/bens/pesquisaAvancada') return { status: 200, body: '' };
    throw new Error(`unexpected network scenario route ${url.pathname}`);
  };
  const network = observerLog();
  await leiloar.collect({ limit: 5, observer: network.observer });
  assert.deepEqual(network.attempts[0].failures, ['network']);
  assert.deepEqual(network.attempts[0].statuses, [200, 200]);
  assert.deepEqual(network.attempts[0].stats, { fetched: 0, skipped: 0, returned: 0, truncated: false });

  setTenants('parser-fixture.invalid');
  routeFixture = (url) => {
    assert.equal(url.hostname, 'www.leiloescentrooeste.com.br');
    return { status: 200, body: JSON.stringify({ items: [null] }) };
  };
  const parser = observerLog();
  await assert.rejects(vlance.collect({ limit: 5, assetTypes: ['veiculo'], observer: parser.observer }));
  assert.deepEqual(parser.attempts[0].statuses, [200]);
  assert.deepEqual(parser.attempts[0].failures, ['parser']);
  assert.deepEqual(parser.attempts[0].stats, { fetched: 1, skipped: 0, returned: 0, truncated: false });
});

test('empty tenant lists and observer start failures remain offline', async () => {
  setTenants(null);
  requests.length = 0;
  routeFixture = () => { throw new Error('unexpected external request'); };
  for (const connector of [leiloar, sishp]) {
    const result = await connector.collect({ limit: 5, observer: { async start() { throw new Error('unexpected attempt'); } } });
    assert.deepEqual(result.lots, []);
  }
  setTenants('start-failure.invalid');
  for (const connector of [vlance, leiloar, sishp]) {
    let starts = 0;
    await assert.rejects(connector.collect({
      limit: 5,
      observer: { async start() { starts++; throw new Error('ledger insert failed'); } },
    }), /ledger insert failed/);
    assert.equal(starts, 1);
  }
  assert.deepEqual(requests, []);
});

test.after(() => { pg.Pool.prototype.query = queryOriginal; });
