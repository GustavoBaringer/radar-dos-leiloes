import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectHtmlAgendaMonitor, isMonitorOnlyDomain } from '../src/connectors/htmlagenda.js';

function attemptLog() {
  const log: { responses: number[]; failures: string[]; finished?: any } = { responses: [], failures: [] };
  return {
    log,
    attempt: {
      response: (status: number) => log.responses.push(status),
      failure: (kind = 'network') => log.failures.push(kind),
      finish: async (stats: any) => { log.finished = stats; },
    },
  };
}

function fakeFetch(pages: Record<string, string>, status = 200) {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(new URL(url).pathname + new URL(url).search);
    return { status, body: pages[new URL(url).pathname + new URL(url).search] ?? '', headers: {} };
  }) as any;
  return { fetcher, urls };
}

test('reviewed monitor tenants are exact and explicit zero-catalog signals complete with no lots', async () => {
  const cases = [
    ['coliseumleiloes.com.br', {
      '/': '<h1>Coliseum Leilões</h1>',
      '/agenda/site/agenda-leiloes.php?tipoLeilao=1': 'Veículos e Equipamentos EM LOTEAMENTO (Aguarde os lotes)',
      '/agenda/site/agenda-leiloes.php?tipoLeilao=3': 'Imóveis EM LOTEAMENTO (Aguarde os lotes)',
    }],
    ['leiloesbrasilpe.com.br', {
      '/': '<a href="/leilao/3">Prefeitura de Brejinho</a>',
      '/leiloes': 'Nenhum bem cadastrado', '/leilao/3': '00/00/0000 EM BREVE Nenhum bem cadastrado',
    }],
  ] as const;
  for (const [domain, pages] of cases) {
    assert.equal(isMonitorOnlyDomain(`www.${domain}`), true);
    const { log, attempt } = attemptLog();
    const { fetcher } = fakeFetch(pages);
    const result = await collectHtmlAgendaMonitor(domain, attempt, fetcher);
    assert.deepEqual(result.lots, []);
    assert.equal(log.finished.returned, 0);
    assert.deepEqual(log.failures, []);
    assert.ok(log.responses.length > 0);
  }
});

test('DNS/network failure is recorded and thrown, not converted to an empty success', async () => {
  const { log, attempt } = attemptLog();
  const failure = Object.assign(async () => { throw new Error('ENOTFOUND'); }, {}) as any;
  await assert.rejects(collectHtmlAgendaMonitor('albuquerqueleiloes.com.br', attempt, failure), /ENOTFOUND/);
  assert.deepEqual(log.failures, ['network']);
});

test('GHVM without a proven public catalog fails pending-contract instead of borrowing external listings', async () => {
  const { log, attempt } = attemptLog();
  const { fetcher } = fakeFetch({ '/': '<a href="/rss.xml">RSS</a>' });
  await assert.rejects(collectHtmlAgendaMonitor('ghvmleiloes.com.br', attempt, fetcher), /vínculo de catálogo GHVM não confirmado/);
  assert.deepEqual(log.failures, ['parser']);
});

test('Portal dos Leilões monitor never publishes even valid-looking lot cards', async () => {
  const { log, attempt } = attemptLog();
  const { fetcher } = fakeFetch({
    '/': '<a href="/lote/123">Apartamento residencial lance inicial R$ 100.000</a><span>1 lote</span>',
  });
  const result = await collectHtmlAgendaMonitor('portaldosleiloes.com.br', attempt, fetcher);
  assert.deepEqual(result.lots, []);
  assert.ok(result.fetched > 0);
  assert.equal(log.finished.returned, 0);
});

test('HTTP errors remain recorded instead of being treated as HTTP 200 zero-results', async () => {
  const { log, attempt } = attemptLog();
  const { fetcher } = fakeFetch({}, 403);
  await assert.rejects(collectHtmlAgendaMonitor('albuquerqueleiloes.com.br', attempt, fetcher), /HTTP 403/);
  assert.deepEqual(log.responses, [403]);
});
