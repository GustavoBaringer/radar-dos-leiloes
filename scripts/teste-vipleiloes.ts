import assert from 'node:assert/strict';
import { collectVipLeiloes } from '../src/connectors/vipleiloes.js';
import { CollectionCancellationError, withCollectionCancellation } from '../src/core/collection-cancellation.js';

function attemptTracker() {
  const attempts: Array<{ domain: string; responses: number[]; failures: string[]; stats?: any }> = [];
  return {
    attempts,
    observer: { async start(domain: string) {
      const item = { domain, responses: [] as number[], failures: [] as string[], stats: undefined as any };
      attempts.push(item);
      return { response: (status: number) => item.responses.push(status), failure: (kind = 'network') => item.failures.push(kind), finish: async (stats: any) => { item.stats = stats; } };
    } },
  };
}

const carPage = `<div id="Holder_lblStatus">Aberto</div><span id="Holder_lblLeilaoData">14/10/2026 - 16h00</span><div id="Holder_lll"><div class="auction-card"><a href="/leilao/86727/lote/912711"><div class="address">Fiat Siena EL 1.4 Flex, ano 13/14</div><img src="/img/siena.png"><div class="status-lt1 blue">Aberto</div><strong>VEÍCULOS</strong><span class="valor-lance">17.130</span><span class="valor-centavo">,50</span></a></div></div>`;
const homeFor = (id: string, date: string) => `<div class="auction-card"><div class="status blue"><span>ABERTO</span></div><a href="/leilao/${id}">Leilão</a><span class="card-value">${date}</span></div>`;
const lanceHome = `<a href="/filtro/carros">Carros</a><a href="/filtro/motos">Motos</a><a href="/filtro/pesados">Pesados</a><a href="/filtro/outros">Outros</a><a href="/filtro/imoveis">Imóveis</a>`;
const lanceCard = (event: string, id: string, title: string, amount = '112.940', cents = ',24') => `<div class="col-md-3 btn-leilao"><a href="../leilao/${event}/lote/${id}"><img class="lote-img" src="/imovel.jpg"><div class="lote-descricao">${title}</div><span class="lote-valor">${amount}</span><span class="lote-valor-centavo">${cents}</span></a></div>`;
const lancePage = (cards = '', links = '', total = 0) => `<span id="ContentPlaceHolder1_lblTotalRegistros">${total}</span><div id="ContentPlaceHolder1_dvLote">${cards}</div><div class="pagination">${links}</div>`;
const pageLink = (page: number) => `<a href="?pag=${page}">${page}</a>`;
const lanceDetails: Record<string, string> = {
  '935554': `<span id="ContentPlaceHolder1_lblCategoria">IMÓVEIS</span><span id="ContentPlaceHolder1_lblCate">Imóvel Comercial</span><span id="ContentPlaceHolder1_lblTitulo1">BENS MED.</span><span id="ContentPlaceHolder1_lblTitulo2">SERRA CAIADA | RIO GRANDE DO NORTE</span><span id="ContentPlaceHolder1_lblDescricaoImovel">01 (um) imóvel residencial à situado na Rua Antônio Cícero Praxedes, nº 31, Conjunto Alto do Céu, Serra Caiada-RN</span><span id="ContentPlaceHolder1_lblStatus">Aberto</span><span id="ContentPlaceHolder1_lblDataleilao">13/10/2026 09h00</span>`,
  '946011': `<span id="ContentPlaceHolder1_lblCategoria">BENS MED.</span><span id="ContentPlaceHolder1_lblTitulo1">BENS MED.</span><span id="ContentPlaceHolder1_lblTitulo2">Bens diversos</span><span id="ContentPlaceHolder1_lblOutros">RAIO-X ODONTOLÓGICO XDENT MODELO X70-COLUNA</span><span id="ContentPlaceHolder1_lblStatus">Aberto</span><span id="ContentPlaceHolder1_lblDataleilao">13/10/2026 09h00</span>`,
  '948082': `<span id="ContentPlaceHolder1_lblCategoria">BENS MED.</span><span id="ContentPlaceHolder1_lblTitulo1">Peças para sucata</span><span id="ContentPlaceHolder1_lblOutros">Lote de peças para desmanche</span><span id="ContentPlaceHolder1_lblStatus">Aberto</span><span id="ContentPlaceHolder1_lblDataleilao">13/10/2026 09h00</span>`,
};

async function main() {
  const carTrack = attemptTracker();
  const carResult = await collectVipLeiloes({ limit: 10, tenant: 'www.ericosobral.com.br', observer: carTrack.observer }, {
    fetchText: async (url) => ({ status: 200, headers: {}, body: url.endsWith('/') ? homeFor('86727', '14/10/2026 - 16h00 Aberto') : carPage }),
  });
  assert.equal(carResult.fetched, 1);
  assert.equal(carResult.lots.length, 1);
  assert.equal(carResult.lots[0].externalId, 'ericosobral.com.br:912711');
  assert.equal(carResult.lots[0].auctionStartUtc?.toISOString(), '2026-10-14T19:00:00.000Z');
  assert.equal(carTrack.attempts[0].stats?.truncated, true);

  let calls = 0;
  await assert.rejects(() => collectVipLeiloes({ limit: 10, tenant: 'not-approved.example' }, { fetchText: async () => { calls++; throw new Error('must not fetch'); } }), /fora da população elegível/);
  assert.equal(calls, 0);

  const lance = attemptTracker();
  const pageRequests: string[] = [];
  const lanceResult = await collectVipLeiloes({ limit: 20_000, tenant: 'lancecertoleiloes.com.br', observer: lance.observer }, {
    fetchText: async (url) => {
      if (url.endsWith('/home')) return { status: 200, headers: {}, body: lanceHome };
      if (url.includes('/leilao/')) return { status: 200, headers: {}, body: lanceDetails[url.match(/\/lote\/(\d+)/)?.[1] ?? ''] ?? lanceDetails['946011'] };
      pageRequests.push(url);
      const parsed = new URL(url);
      const route = parsed.pathname.split('/').pop();
      if (['carros', 'motos', 'pesados'].includes(route ?? '')) return { status: 200, headers: {}, body: lancePage('', pageLink(1), 0) };
      if (route === 'outros') {
        const page = Number(parsed.searchParams.get('pag') ?? 0);
        const cards = page === 0 ? lanceCard('evento', '946011', 'RAIO-X ODONTOLÓGICO') : page === 2 ? lanceCard('evento', '948082', 'Peças para sucata') : lanceCard('evento', String(950000 + page), `Material sem classificação ${page}`);
        return { status: 200, headers: {}, body: lancePage(cards, [...Array.from({ length: 14 }, (_, i) => pageLink(i + 1))].join(''), 14) };
      }
      if (route === 'imoveis') return { status: 200, headers: {}, body: lancePage(`${lanceCard('131026VT1', '935554', 'Imóvel residencial — descrição resumida', '112.940', ',24')}${lanceCard('TESTEVIP', '1', 'demo')}`, pageLink(1), 1) };
      return { status: 200, headers: {}, body: lancePage() };
    },
  });
  assert.equal(lanceResult.fetched, 15);
  assert.equal(lanceResult.skipped, 14);
  assert.equal(lanceResult.lots.length, 1);
  assert.equal(lanceResult.lots[0].externalId, 'lancecertoleiloes.com.br:935554');
  assert.equal(lanceResult.lots[0].lotUrl, 'https://www.lancecertoleiloes.com.br/leilao/131026VT1/lote/935554');
  assert.match(lanceResult.lots[0].titleRaw, /Rua Antônio Cícero Praxedes/);
  assert.equal(lanceResult.lots[0].assetType, 'imovel');
  assert.equal(lanceResult.lots[0].propertyType, 'comercial');
  assert.equal(lanceResult.lots[0].sourceCategory, 'IMÓVEIS');
  assert.equal(lanceResult.lots[0].sourceGroup, 'Imóvel Comercial');
  assert.equal(lanceResult.lots[0].currentBid, 112940.24);
  assert.equal(lanceResult.lots[0].auctionStartUtc?.toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(lanceResult.note, undefined);
  assert.equal(pageRequests.length, 18);
  assert.equal(new Set(pageRequests).size, pageRequests.length);
  assert.deepEqual(pageRequests.slice(0, 3).map((url) => new URL(url).pathname), ['/filtro/carros', '/filtro/motos', '/filtro/pesados']);
  assert.equal(new URL(pageRequests[17]).pathname, '/filtro/imoveis');
  assert.ok(!lanceResult.lots.some((lot) => /946011|948082/.test(lot.externalId)));
  assert.equal(lance.attempts[0].stats?.fetched, 15);
  assert.equal(lance.attempts[0].stats?.truncated, false);

  const network = attemptTracker();
  const offline = await collectVipLeiloes({ limit: 10, tenant: 'lancecertoleiloes.com.br', observer: network.observer }, { fetchText: async () => { throw new Error('offline'); } });
  assert.equal(offline.lots.length, 0);
  assert.deepEqual(network.attempts[0].failures, ['network']);
  assert.ok(network.attempts[0].stats);

  const http = await collectVipLeiloes({ limit: 10, tenant: 'lancecertoleiloes.com.br' }, {
    fetchText: async (url) => ({ status: url.endsWith('/home') ? 200 : 503, headers: {}, body: url.endsWith('/home') ? lanceHome : '' }),
  });
  assert.equal(http.lots.length, 0);
  assert.match(http.note ?? '', /falhas HTTP: 5/);

  const cancelled = attemptTracker();
  await assert.rejects(() => withCollectionCancellation({ timeoutMs: 1 }, () => collectVipLeiloes({ limit: 10, tenant: 'lancecertoleiloes.com.br', observer: cancelled.observer }, {
    fetchText: async () => new Promise((_resolve, reject) => setTimeout(() => reject(new CollectionCancellationError('deadline')), 5)),
  })), CollectionCancellationError);
  assert.deepEqual(cancelled.attempts[0].failures, ['budget']);
  assert.ok(cancelled.attempts[0].stats);
  console.log('VIP Leilões checks passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
