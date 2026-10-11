import assert from 'node:assert/strict';
import { collectSoleon } from '../src/connectors/soleon.js';
import { withCollectionCancellation, CollectionCancellationError } from '../src/core/collection-cancellation.js';
import type { query } from '../src/core/db.js';

const originalDomains = process.env.SOLEON_DOMAINS;
const originalTenants = process.env.SOLEON_TENANTS;
const card = (id: number, title = `Honda Civic ${id}`) => `<div class="lote"><h4>Lote ${id}</h4><a href="/item/${id}/detalhes"></a><h5>${title}</h5><div class="label_lote aberto_lance">Aberto</div><div class="etiqueta">Lance Inicial</div><h4>R$ 100,00</h4></div>`;
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

  // Colodete's active homepage links an equipment-only event not present in the two global categories.
  process.env.SOLEON_DOMAINS = 'colodeteleiloes.com.br';
  const equipmentHost = 'colodeteleiloes.com.br';
  const root = `<html><div class="box-leilao"><a href="https://${equipmentHost}/leilao/1715/lotes"><h6 class="card-title">Leilão Justiça do Trabalho - Spin</h6></a><div class="ativo label_leilao">Em Andamento</div><div class="card-text">Veículo Chevrolet Spin</div></div>
  <div class="box-leilao"><a href="https://${equipmentHost}/leilao/1716/lotes"><h6 class="card-title">Leilão Justiça do Trabalho - Compressor Industrial</h6></a><div class="ativo label_leilao">Em Andamento</div><div class="card-text">Compressor Industrial</div></div>
  <div class="box-leilao"><a href="https://${equipmentHost}/leilao/1600/lotes"><h6 class="card-title">Compressor antigo</h6></a><div class="label_leilao">Encerrado</div></div></html>`;
  const equipmentCard = `<div class="lote"><h4>Lote 001</h4><a href="/item/14157/detalhes?page=1" style="background:url('https://colodeteleiloes.com.br/site/images/sem-imagem-lote.jpg')"></a>
  <h5>COMPRESSOR INDUSTRIAL</h5><div style="text-align: justify !important"><b>Descrição:</b> Compressor Wayne, 25 pés, reservatório 250 litros.</div>
  <div class="label_lote aguarde_abertura">Aguarde Abertura</div><div class="etiqueta">Lance Inicial</div><h4>R$6.000,00</h4></div>`;
  const equipmentCalls: string[] = [];
  const detailDates = new Date('2026-11-17T17:00:00Z');
  const equipmentIo = {
    query: fakeQuery([]),
    fetchText: (async (url: string) => {
      equipmentCalls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/') return result(root);
      if (parsed.pathname.includes('/lotes/veiculo')) return result(card(14156, 'CHEVROLET SPIN'));
      if (parsed.pathname.includes('/lotes/imovel')) return result('');
      if (parsed.pathname === '/leilao/1716/lotes') return result(equipmentCard + card(14156, 'CHEVROLET SPIN'));
      if (parsed.pathname === '/item/14156/detalhes' || parsed.pathname === '/item/14157/detalhes') {
        return result('<meta property="og:description" content="Leilão:17/11/2026 às14:00"><h5>LEILOEIRO OFICIAL</h5>Mauro Colodete<br>');
      }
      throw new Error(`unexpected equipment request ${url}`);
    }) as any,
  };
  const equipmentFirst = await collectSoleon({ limit: 100 }, equipmentIo);
  const compressor = equipmentFirst.lots.find((lot) => lot.externalId === `${equipmentHost}:14157`);
  assert.ok(compressor, 'home -> active event 1716 -> item 14157 is collected');
  assert.equal(compressor.assetType, 'veiculo');
  assert.equal(compressor.vehicleType, 'maquina');
  assert.equal(compressor.status, 'agendado');
  assert.equal(compressor.auctionStartUtc?.toISOString(), '2026-11-17T17:00:00.000Z');
  assert.deepEqual(compressor.photos, [], 'sem-imagem-lote placeholder is not emitted as a lot photo');
  assert.equal(equipmentFirst.lots.filter((lot) => lot.externalId === `${equipmentHost}:14156`).length, 1,
    'overlap between global and event listings is deduplicated');
  assert.ok(!equipmentCalls.some((url) => url.includes('/leilao/1715/lotes') || url.includes('/leilao/1600/lotes')),
    'non-equipment and ended events are not fetched for the targeted supplement');
  assert.equal(equipmentCalls.filter((url) => url.includes('/item/')).length, 2);

  const equipmentKnown = [14156, 14157].map((id) => lotRow(`${equipmentHost}:${id}`, detailDates));
  let repeatDetailCalls = 0;
  const equipmentRepeatIo = {
    query: fakeQuery(equipmentKnown),
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) repeatDetailCalls++;
      if (url.endsWith('/')) return result(root);
      const parsed = new URL(url);
      if (parsed.pathname.includes('/lotes/veiculo')) return result(card(14156, 'CHEVROLET SPIN'));
      if (parsed.pathname.includes('/lotes/imovel')) return result('');
      if (parsed.pathname === '/leilao/1716/lotes') return result(equipmentCard + card(14156, 'CHEVROLET SPIN'));
      throw new Error(`unexpected repeated equipment request ${url}`);
    }) as any,
  };
  const equipmentRepeat = await collectSoleon({ limit: 100 }, equipmentRepeatIo);
  assert.equal(repeatDetailCalls, 0, 'known name/date metadata prevents per-item detail refetch on recurrence');
  assert.equal(equipmentRepeat.lots.find((lot) => lot.externalId === `${equipmentHost}:14157`)?.vehicleType, 'maquina');

  const equipmentAbort = new AbortController();
  const machineAbortLog = observerLog();
  const abortMachineIo = {
    query: fakeQuery([]),
    fetchText: (async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/lotes/veiculo') || parsed.pathname.includes('/lotes/imovel')) return result('');
      if (parsed.pathname === '/') return result(root);
      if (parsed.pathname === '/leilao/1716/lotes') {
        const error = new CollectionCancellationError('deadline');
        equipmentAbort.abort(error);
        throw error;
      }
      throw new Error(`request after cancellation: ${url}`);
    }) as any,
  };
  await assert.rejects(withCollectionCancellation({ signal: equipmentAbort.signal }, () =>
    collectSoleon({ limit: 100, observer: machineAbortLog.observer }, abortMachineIo)), CollectionCancellationError);
  assert.deepEqual(machineAbortLog.attempts[0].failures, ['budget']);
  assert.ok(machineAbortLog.attempts[0].finish, 'supplement cancellation still finalizes the tenant attempt');

  // The diverse route has no query string; it must be requested only for the
  // two observed tenants, and its cards use the ordinary classifiers.
  const diverseHost = 'focoleiloes.com.br';
  process.env.SOLEON_DOMAINS = diverseHost;
  const diverseCalls: string[] = [];
  const diverseCards = `<div class="lote"><a href="/item/701/detalhes"></a><h5>Compressor industrial</h5><div class="label_lote aguarde_abertura"></div></div>
    <div class="lote"><a href="/item/702/detalhes"></a><h5>Casa residencial</h5><div class="label_lote aberto_lance"></div></div>`;
  const diverseIo = {
    query: fakeQuery([lotRow(`${diverseHost}:701`), lotRow(`${diverseHost}:702`)]),
    fetchText: (async (url: string) => {
      diverseCalls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.includes('/lotes/')) return result(parsed.pathname === '/lotes/diversos' ? diverseCards : '');
      throw new Error(`unexpected diverse request ${url}`);
    }) as any,
  };
  const diverse = await collectSoleon({ limit: 2 }, diverseIo);
  assert.ok(diverseCalls.includes(`https://${diverseHost}/lotes/diversos?page=1`), 'diversos page uses valid query separator');
  assert.equal(diverse.lots.length, 2);
  assert.equal(diverse.lots[0].vehicleType, 'maquina');
  assert.equal(diverse.lots[1].assetType, 'imovel');
  process.env.SOLEON_DOMAINS = 'ordinary.soleon.test';
  const ordinaryCalls: string[] = [];
  await collectSoleon({ limit: 2 }, {
    query: fakeQuery([]),
    fetchText: (async (url: string) => { ordinaryCalls.push(url); return result(''); }) as any,
  });
  assert.ok(!ordinaryCalls.some((url) => url.includes('/lotes/diversos')), 'diversos is limited to observed tenants');
  console.log('SOLEON fluxo: repetição, sobreposição, cache, cancelamento e cota OK');
} finally {
  if (originalDomains === undefined) delete process.env.SOLEON_DOMAINS; else process.env.SOLEON_DOMAINS = originalDomains;
  if (originalTenants === undefined) delete process.env.SOLEON_TENANTS; else process.env.SOLEON_TENANTS = originalTenants;
}
