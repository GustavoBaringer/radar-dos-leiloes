import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectSoleon } from '../src/connectors/soleon.js';
import type { query } from '../src/core/db.js';

const oldDomains = process.env.SOLEON_DOMAINS;
const oldTenants = process.env.SOLEON_TENANTS;
const emptyQuery = (async <T>() => []) as typeof query;
const response = (body: string, status = 200) => ({ body, status, headers: {} });
const card = (id: number, h5: string, description: string) => `<div class="lote"><h4>Lote ${id}</h4><a href="/item/${id}/detalhes"></a><h5>${h5}</h5><div style="text-align: justify !important"><b>Descrição:</b> ${description}</div><div class="label_lote em_breve">Em Breve</div><div class="etiqueta">Lance Inicial</div><h4>R$0,00</h4></div>`;
const detail = response('<meta property="og:description" content="Leilão: 03/11/2026 às 09:00, Veículo Conservado">');

try {
  process.env.SOLEON_DOMAINS = 'focoleiloes.com.br';
  const fixture = await readFile(new URL('../fixtures/soleon/foco-veiculo-33367.html', import.meta.url), 'utf8');
  const calls: string[] = [];
  const realFixtureResult = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      calls.push(url);
      if (url.includes('/item/')) return detail;
      if (url.includes('/lotes/veiculo')) return response(fixture);
      return response('');
    }) as never,
  });
  assert.equal(realFixtureResult.lots.length, 3);
  assert.equal(realFixtureResult.lots[0].titleRaw, 'YAMAHA/FACTOR YBR125 K');
  assert.equal(realFixtureResult.lots[0].assetType, 'veiculo');
  assert.equal(realFixtureResult.lots[0].vehicleType, 'moto');
  assert.equal(realFixtureResult.lots[0].status, 'sem_data');
  assert.equal(realFixtureResult.lots[0].auctionStartUtc?.toISOString(), '2026-11-03T12:00:00.000Z');
  assert.equal(realFixtureResult.lots[0].minBid, null, 'R$0,00 is not promoted as price');
  assert.equal((realFixtureResult.lots[0].raw as { condition: string }).condition, 'conservado');
  assert.match(realFixtureResult.note ?? '', /limite solicitado \(3\) atingido/);
  assert.equal(calls.filter((url) => url.includes('/item/')).length, 3);

  const existingVehicleQuery = (async <T>(sql: string) => sql.includes('FROM lots')
    ? [{ external_id: 'focoleiloes.com.br:33367', auctioneer_name: 'Leiloeiro já conhecido', auction_start_utc: null }] as T[]
    : []) as typeof query;
  const existingVehicleCalls: string[] = [];
  const enrichedExistingVehicle = await collectSoleon({ limit: 1 }, {
    query: existingVehicleQuery,
    fetchText: (async (url: string) => {
      existingVehicleCalls.push(url);
      if (url.includes('/item/')) return detail;
      if (url.includes('/lotes/veiculo')) return response(fixture);
      return response('');
    }) as never,
  });
  assert.ok(existingVehicleCalls.some((url) => url.includes('/item/33367/detalhes')), 'known vehicle missing date re-fetches detail');
  assert.equal(enrichedExistingVehicle.lots[0].auctionStartUtc?.toISOString(), '2026-11-03T12:00:00.000Z');
  assert.equal(enrichedExistingVehicle.lots[0].auctioneerName, 'Leiloeiro já conhecido', 'existing name is retained');

  process.env.SOLEON_DOMAINS = 'colodeteleiloes.com.br';
  const machineExistingQuery = (async <T>(sql: string) => sql.includes('FROM lots')
    ? [{ external_id: 'colodeteleiloes.com.br:94', auctioneer_name: 'Leiloeiro já conhecido', auction_start_utc: null }] as T[]
    : []) as typeof query;
  const machineDetailCalls: string[] = [];
  const enrichedExistingMachine = await collectSoleon({ limit: 3 }, {
    query: machineExistingQuery,
    fetchText: (async (url: string) => {
      machineDetailCalls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/lotes/veiculo' || parsed.pathname === '/lotes/imovel') return response('');
      if (parsed.pathname === '/') return response(`<div class="box-leilao"><a href="https://colodeteleiloes.com.br/leilao/901/lotes"><h6 class="card-title">Compressor Industrial</h6></a><div class="ativo label_leilao">Em Andamento</div><div class="card-text">Compressor industrial</div></div>`);
      if (parsed.pathname === '/leilao/901/lotes') return response(card(94, 'Compressor Industrial', 'Compressor Wayne'));
      if (parsed.pathname === '/item/94/detalhes') return detail;
      return response('');
    }) as never,
  });
  assert.ok(machineDetailCalls.some((url) => url.includes('/item/94/detalhes')), 'known machine missing date also re-fetches detail');
  assert.equal(enrichedExistingMachine.lots[0].auctionStartUtc?.toISOString(), '2026-11-03T12:00:00.000Z');
  process.env.SOLEON_DOMAINS = 'focoleiloes.com.br';

  const sucataResult = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) return detail;
      if (url.includes('/lotes/veiculo')) return response(fixture.replaceAll('Veículo Conservado', 'Veículo SUCATA'));
      return response('');
    }) as never,
  });
  assert.equal(sucataResult.lots.length, 3, 'sucata description does not erase identified make/model');
  assert.equal((sucataResult.lots[0].raw as { condition: string }).condition, 'sucata');

  const pieceResult = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/lotes/veiculo')) return response(fixture.replaceAll('Veículo Conservado', 'Peça de motocicleta, carenagem avariada'));
      return response('');
    }) as never,
  });
  assert.equal(pieceResult.lots.length, 0, 'part classification in description excludes titled motorcycles');
  assert.equal(pieceResult.skipped, 3);

  const diverse = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) return detail;
      if (url.includes('/lotes/diversos')) return response(card(71, 'LOTE-0001', 'Compressor industrial Wayne'));
      return response('');
    }) as never,
  });
  assert.equal(diverse.lots.length, 1);
  assert.equal(diverse.lots[0].vehicleType, 'maquina');
  assert.equal(diverse.lots[0].sourceCategory, 'maquina');
  assert.equal((diverse.lots[0].raw as { condition: string }).condition, 'desconhecido');

  const parts = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/lotes/diversos')) return response(card(72, 'LOTE-0002', 'Peça de motocicleta, carenagem avariada'));
      return response('');
    }) as never,
  });
  assert.equal(parts.lots.length, 0, 'diversos does not leak pieces');
  assert.equal(parts.skipped, 1);

  const errors: string[] = [];
  const failedCategory = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/lotes/veiculo')) return response('upstream error', 503);
      return response('');
    }) as never,
  });
  errors.push(failedCategory.note ?? '');
  assert.equal(failedCategory.httpStatus, 200, 'later HTTP 200 remains the final status');
  assert.match(errors[0], /lotes\/veiculo\?tipo=veiculo: HTTP 503/);

  const oneListedVehicle = card(90, 'Honda Civic LX', 'Veículo Conservado');
  const detailFailure = await collectSoleon({ limit: 100 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) return response('detail unavailable', 503);
      if (url.includes('/lotes/veiculo')) return response(oneListedVehicle);
      return response('');
    }) as never,
  });
  assert.equal(detailFailure.httpStatus, 200);
  assert.match(detailFailure.note ?? '', /item\/90: detalhe HTTP 503/);

  const networkDetailFailure = await collectSoleon({ limit: 100 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) throw new Error('synthetic network failure');
      if (url.includes('/lotes/veiculo')) return response(oneListedVehicle);
      return response('');
    }) as never,
  });
  assert.match(networkDetailFailure.note ?? '', /item\/90: falha de rede no detalhe/);

  const detailWithoutMetadata = await collectSoleon({ limit: 100 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      if (url.includes('/item/')) return response('<html><title>Detalhe sem metadados</title></html>');
      if (url.includes('/lotes/veiculo')) return response(oneListedVehicle);
      return response('');
    }) as never,
  });
  assert.equal(detailWithoutMetadata.note, undefined, '200 detail without optional metadata is not a failure');

  process.env.SOLEON_DOMAINS = 'ccjleiloes.com.br';
  const ccjCalls: string[] = [];
  const ccj = await collectSoleon({ limit: 3 }, {
    query: emptyQuery,
    fetchText: (async (url: string) => {
      ccjCalls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/') return response('<a href="https://ccjleiloes.com.br/leilao/991/lotes">evento verificado</a>');
      if (parsed.pathname.startsWith('/lotes/')) return response('');
      if (parsed.pathname === '/leilao/991/lotes' && parsed.searchParams.get('page') === '2') return response(card(82, 'Casa residencial', 'Casa residencial'));
      if (parsed.pathname === '/leilao/991/lotes') return response(`${card(81, 'Compressor Industrial', 'Compressor industrial')}
        <a href="https://ccjleiloes.com.br/leilao/991/lotes?page=2">2</a>`);
      if (parsed.pathname === '/item/81/detalhes' || parsed.pathname === '/item/82/detalhes') return detail;
      return response('');
    }) as never,
  });
  assert.ok(ccjCalls.includes('https://ccjleiloes.com.br/leilao/991/lotes'), 'follows the literal event URL from home');
  assert.ok(ccjCalls.includes('https://ccjleiloes.com.br/leilao/991/lotes?page=2'), 'follows only the observed page link');
  assert.equal(ccj.lots.length, 2, 'empty global category pages do not hide the home event');
  assert.ok(ccj.lots.some((lot) => lot.vehicleType === 'maquina'));
  assert.ok(ccj.lots.some((lot) => lot.assetType === 'imovel'));
  console.log('SOLEON escopo: fixture real, diversos, exclusões, notas parciais e evento CCJ OK');
} finally {
  if (oldDomains === undefined) delete process.env.SOLEON_DOMAINS; else process.env.SOLEON_DOMAINS = oldDomains;
  if (oldTenants === undefined) delete process.env.SOLEON_TENANTS; else process.env.SOLEON_TENANTS = oldTenants;
}
