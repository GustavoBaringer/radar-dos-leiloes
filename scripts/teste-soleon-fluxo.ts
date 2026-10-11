import assert from 'node:assert/strict';
import { collectSoleon } from '../src/connectors/soleon.js';
import { withCollectionCancellation, CollectionCancellationError } from '../src/core/collection-cancellation.js';
import type { query } from '../src/core/db.js';

const originalDomains = process.env.SOLEON_DOMAINS;
const originalTenants = process.env.SOLEON_TENANTS;
const card = (id: number, title = `Veículo teste ${id}`) => `<div class="lote"><h4>Lote ${id}</h4><a href="/item/${id}/detalhes"></a><h5>${title}</h5><div class="label_lote aberto_lance">Aberto</div><div class="etiqueta">Lance Inicial</div><h4>R$ 100,00</h4></div>`;
const page = (ids: number[], titleFor: (id: number) => string | undefined = () => undefined) => ids.map((id) => card(id, titleFor(id))).join('');
const result = (body: string) => ({ status: 200, body, headers: {} });
const lotRow = (external_id: string, auction_start_utc: Date | null = null) => ({ external_id, auctioneer_name: 'Leiloeiro Teste', auction_start_utc });

function fakeQuery(rows: Array<ReturnType<typeof lotRow>>) {
  return (async <T>(sql: string): Promise<T[]> => sql.includes('FROM lots') ? rows as T[] : []) as typeof query;
}

function observerLog() {
  const attempts: Array<{ host: string; failures: string[]; finish?: any }> = [];
  return {
    attempts,
    observer: { start: async (host: string) => {
      const entry: { host: string; failures: string[]; finish?: any } = { host, failures: [] };
      attempts.push(entry);
      return { response() {}, failure(kind: string) { entry.failures.push(kind); }, finish(value: any) { entry.finish = value; } };
    } } as any,
  };
}

try {
  // Repeated vehicle page ends that category, while overlapping first pages do not
  // prevent the property category from reaching its distinct second page.
  process.env.SOLEON_DOMAINS = 'flow.soleon.test';
  const known = Array.from({ length: 60 }, (_, i) => lotRow(`flow.soleon.test:${i + 1}`, new Date('2026-10-15T12:00:00Z')));
  let detailCalls = 0;
  const calls: string[] = [];
  const fetchText = async (url: string) => {
    calls.push(url);
    const parsed = new URL(url);
    const property = parsed.pathname.includes('imovel');
    const p = Number(parsed.searchParams.get('page'));
    if (parsed.pathname.includes('/item/')) { detailCalls++; return result('<meta property="og:description" content="Leilão:15/10/2026 às12:00">'); }
    if (!property) return result(page(Array.from({ length: 30 }, (_, i) => i + 1)));
    if (p === 1) return result(page(Array.from({ length: 30 }, (_, i) => i + 1)));
    if (p === 2) return result(page(Array.from({ length: 30 }, (_, i) => i + 31), (id) => `Casa residencial ${id}`));
    return result('');
  };
  const io = { fetchText: fetchText as any, query: fakeQuery(known) };
  const first = await collectSoleon({ limit: 100, observer: undefined }, io);
  assert.equal(first.lots.length, 60);
  assert.ok(calls.includes('https://flow.soleon.test/lotes/veiculo?tipo=veiculo&page=2'), 'repeated full page is requested once then ends');
  assert.ok(calls.includes('https://flow.soleon.test/lotes/imovel?tipo=imovel&page=2'), 'overlap on property page 1 does not stop property page 2');
  assert.equal(detailCalls, 0, 'known enriched lots require no detail fetch');
  assert.equal(first.lots.filter((lot) => lot.assetType === 'imovel').length, 30);
  await collectSoleon({ limit: 100 }, io);
  assert.equal(detailCalls, 0, 'second collection of enriched cached lots still makes no detail fetches');

  // Cancellation during detail propagates, records budget, finishes the attempt,
  // and does not request another category or card.
  process.env.SOLEON_DOMAINS = 'abort.soleon.test';
  const controller = new AbortController();
  const abortedLog = observerLog();
  const abortCalls: string[] = [];
  const abortIo = {
    query: fakeQuery([]),
    fetchText: (async (url: string) => {
      abortCalls.push(url);
      if (url.includes('/item/')) {
        const error = new CollectionCancellationError('deadline');
        controller.abort(error);
        throw error;
      }
      return result(card(501));
    }) as any,
  };
  await assert.rejects(withCollectionCancellation({ signal: controller.signal }, () => collectSoleon({ limit: 10, observer: abortedLog.observer }, abortIo)), CollectionCancellationError);
  assert.equal(abortCalls.length, 2, 'only listing and cancelled detail requests occur');
  assert.deepEqual(abortedLog.attempts[0].failures, ['budget']);
  assert.ok(abortedLog.attempts[0].finish, 'aborted tenant attempt is finalized');

  // A short final page with 110 available lots and quota 100 records truncation,
  // then starts processing the next tenant.
  process.env.SOLEON_DOMAINS = 'quota-a.soleon.test,quota-b.soleon.test';
  const quotaLog = observerLog();
  const quotaCalls: string[] = [];
  const available = Array.from({ length: 110 }, (_, i) => i + 1000);
  const allKnown = [...available.map((id) => lotRow(`quota-a.soleon.test:${id}`)), ...Array.from({ length: 110 }, (_, i) => lotRow(`quota-b.soleon.test:${i + 2000}`))];
  const quotaIo = {
    query: fakeQuery(allKnown),
    fetchText: (async (url: string) => {
      quotaCalls.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === 'quota-b.soleon.test') {
        if (parsed.pathname.includes('imovel')) return result('');
        return result(page(Array.from({ length: 30 }, (_, i) => i + 2000)));
      }
      const p = Number(parsed.searchParams.get('page'));
      return result(page(available.slice((p - 1) * 30, p * 30)));
    }) as any,
  };
  const quotaResult = await collectSoleon({ limit: 200, observer: quotaLog.observer }, quotaIo);
  assert.equal(quotaLog.attempts[0].finish.truncated, true, 'first tenant reports remaining cards beyond quota');
  assert.equal(quotaLog.attempts[1].host, 'quota-b.soleon.test', 'collection advances to the next tenant');
  assert.ok(quotaCalls.some((url) => url.startsWith('https://quota-b.soleon.test/')), 'next tenant is actually requested');
  assert.equal(quotaResult.lots.length, 130);
  console.log('SOLEON fluxo: repetição, sobreposição, cache, cancelamento e cota OK');
} finally {
  if (originalDomains === undefined) delete process.env.SOLEON_DOMAINS; else process.env.SOLEON_DOMAINS = originalDomains;
  if (originalTenants === undefined) delete process.env.SOLEON_TENANTS; else process.env.SOLEON_TENANTS = originalTenants;
}
