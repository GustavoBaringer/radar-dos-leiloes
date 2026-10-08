import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPublicAlert, toPublicFavorite, toPublicHit, toPublicLot } from '../src/core/public-dto.js';
import { BoundedInputError, normalizeSearchParams, parsePagination, parseSearchInput, paginateRows, safePositiveId, ValidateAlertInput } from '../src/core/request-bounds.js';
import { getLot, searchLots, searchLotsMapa, type SearchParams } from '../src/core/repo.js';

const lotFixture = (extra: Record<string, unknown> = {}) => ({
  id: 17, source_id: 'superbid', external_id: 'private-external-id', lot_url: 'https://auction.example/lot/17',
  title_raw: 'Honda Civic', title_display: 'Honda Civic 2020', brand: 'HONDA', model: 'CIVIC', version: 'EX',
  year_make: 2019, year_model: 2020, km: 20_000, doc_type: 'conservado', closing_model: 'timer_por_lote',
  auction_start_utc: new Date('2026-10-01T12:00:00.000Z'), auction_end_utc: '2026-11-01T12:00:00.000Z',
  source_tz: 'America/Sao_Paulo', status: 'aberto', current_bid: 50_000, min_bid: 40_000, bid_increment: 500,
  appraisal: 70_000, fees_pct: 5, bid_suspect: false, asset_type: 'veiculo', vehicle_type: 'carro',
  property_type: null, source_category: 'Carro', auctioneer_name: 'Leiloeira Exemplo', auctioneer_reg: 'JUCESP 123',
  area: null, rooms: null, seller_name: 'Maria da Silva', seller_type: 'seguradora', yard: 'Pátio A',
  city: 'São Paulo', state: 'SP', photos: ['https://images.example/1.jpg', 'javascript:alert(1)', 'file:///secret'],
  photo_count: 3, financeable: false, has_report: true, collected_at: new Date('2026-10-02T12:00:00.000Z'),
  first_seen_at: '2026-10-02T12:00:00.000Z', is_novo: true, effective_status: 'aberto', discount_pct: 29,
  color: 'preto', fuel: 'flex', plate_masked: 'ABC-1***',
  bid_history: [{ bid: 50_000, observed_at: new Date('2026-10-03T12:00:00.000Z'), private: 'drop' }],
  raw: { cpf: 'private' }, search_text: 'private', verify_result: 'private', closed_reason: 'private',
  nested_private: { secret: 'private' }, ...extra,
});

function fakeQuery<T>(handler: (sql: string, params: any[]) => Promise<unknown[]> | unknown[]): (sql: string, params?: any[]) => Promise<T[]> {
  return async (sql, params = []) => await handler(sql, params) as T[];
}

test('request bounds parse strict multi-values, numeric ranges, places and pagination', () => {
  const parsed = parseSearchInput({
    q: 'civic', uf: 'SP,RJ', vehicleType: ['carro', 'suv'], priceMin: '100.50', priceMax: '200',
    yearMin: '1980', yearMax: '2026', onlyWithPhoto: 'true', place: 'c:SAO PAULO/SP;-23.5,-46.6',
    page: '100', pageSize: '100', sort: 'recent', endsWithin: '7d',
  });
  assert.deepEqual(parsed.uf, ['SP', 'RJ']);
  assert.deepEqual(parsed.vehicleType, ['carro', 'suv']);
  assert.equal(parsed.priceMin, 100.5);
  assert.deepEqual(parsePagination('100', '100'), { page: 100, pageSize: 100, offset: 9900 });
  assert.deepEqual(parsePagination(), { page: 1, pageSize: 24, offset: 0 });
  assert.throws(() => parseSearchInput({ q: 'x'.repeat(201) }), (error: unknown) => {
    assert.ok(error instanceof BoundedInputError);
    assert.equal(error.statusCode, 400);
    assert.doesNotMatch(error.message, /x{5}/);
    return true;
  });
  assert.throws(() => parseSearchInput({ uf: Array.from({ length: 21 }, () => 'SP') }), BoundedInputError);
  assert.throws(() => parseSearchInput({ page: '1.5' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ page: 'Infinity' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ page: ['1', '2'] }), BoundedInputError);
  assert.throws(() => parseSearchInput({ priceMin: '-1' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ priceMin: '20', priceMax: '10' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ onlyWithPhoto: 'yes' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ status: 'inventado' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ place: '91,0' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ place: 'c:SAO PAULO/XX' }), BoundedInputError);
  assert.throws(() => parseSearchInput({ q: { toString: () => 'x' } }), BoundedInputError);
  assert.equal(safePositiveId('17'), 17);
  assert.equal(safePositiveId(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(safePositiveId('0'), null);
  assert.equal(safePositiveId('17', { allowString: false }), null);
  assert.deepEqual(paginateRows([9, 8, 7], 3, 2), { items: [9, 8], page: 3, pageSize: 2, hasMore: true });
});

test('new/edit alert inputs allow only matcher fields and bounded channels/email', () => {
  const alert = ValidateAlertInput({
    q: 'civic', label: 'Honda', filters: { assetType: 'veiculo', vehicleType: 'carro,suv', onlyWithPhoto: true, yearMin: 2000 },
    channels: ['sino', 'push'],
  });
  assert.deepEqual(alert.channels, ['sino', 'push']);
  assert.equal(alert.filters?.vehicleType, 'carro,suv');
  assert.deepEqual(ValidateAlertInput({ label: 'Novo', channels: ['sino'], email: null }, { edit: true }), {
    label: 'Novo', q: undefined, filters: undefined, channels: ['sino'], email: null,
  });
  assert.throws(() => ValidateAlertInput({ q: 'x'.repeat(201), filters: {} }), BoundedInputError);
  assert.throws(() => ValidateAlertInput({ q: 'civic', filters: { place: '-23,-46' } }), BoundedInputError);
  assert.throws(() => ValidateAlertInput({ q: 'civic', filters: { priceMin: 'NaN' } }), BoundedInputError);
  assert.throws(() => ValidateAlertInput({ q: 'civic', filters: { vehicleType: { x: 1 } } }), BoundedInputError);
  assert.throws(() => ValidateAlertInput({ q: 'civic', channels: ['email'] }), BoundedInputError);
  assert.throws(() => ValidateAlertInput({ q: 'civic', extra: true }), BoundedInputError);
});

test('public DTO allowlists protect detail, hits, favorites and alert rows', () => {
  const dto = toPublicLot(lotFixture());
  assert.equal(dto.id, 17);
  assert.equal(dto.seller_name, 'Maria S.');
  assert.equal(dto.photos.length, 1);
  assert.equal(toPublicLot(lotFixture({ lot_url: `https://auction.example/${'x'.repeat(4100)}` })).lot_url?.length, 4124);
  assert.equal(dto.auction_start_utc, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(dto.bid_history, [{ bid: 50_000, observed_at: '2026-10-03T12:00:00.000Z' }]);
  assert.equal('external_id' in dto, false);
  for (const key of ['raw', 'search_text', 'verify_result', 'closed_reason', 'nested_private']) assert.equal(key in dto, false);
  const hit = toPublicHit({ ...lotFixture(), seen: true, hit_em: new Date('2026-10-04T00:00:00Z'), labels: ['Honda'], alertas: 7 });
  assert.equal(hit.seen, true);
  assert.deepEqual(hit.labels, ['Honda']);
  assert.equal('alertas' in hit, false);
  const favorite = toPublicFavorite({ ...lotFixture(), favorited_em: '2026-10-05T00:00:00Z' });
  assert.equal(favorite.favorited_em, '2026-10-05T00:00:00Z');
  const alert = toPublicAlert({ id: 4, owner_id: 999, label: 'Lote', q: 'civic', channels: ['push', 'unsafe'], email: 'x@example.test', total: 3, nao_vistos: 2, secret: 'drop' });
  assert.deepEqual(alert, { id: 4, label: 'Lote', q: 'civic', channels: ['push'], email: 'x@example.test', total: 3, nao_vistos: 2, filters: {} });
});

test('invalid repository search is rejected before any injected DB query', async () => {
  let calls = 0;
  const queryFn = fakeQuery(() => { calls++; return []; });
  await assert.rejects(searchLots({ q: 'x'.repeat(201) }, queryFn), BoundedInputError);
  await assert.rejects(searchLotsMapa({ page: 101 }, queryFn), BoundedInputError);
  assert.equal(calls, 0);
});

test('search result omits external ids/internal fields through public projection', async () => {
  const queryFn = fakeQuery((sql) => {
    if (sql.includes('SELECT COUNT(*)::int AS count FROM lots')) return [{ count: 1 }];
    if (sql.includes('SELECT id, source_id, lot_url')) return [lotFixture()];
    return [];
  });
  const result = await searchLots({ q: 'civic', page: 1, pageSize: 24 }, queryFn);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].seller_name, 'Maria S.');
  assert.equal('external_id' in result.items[0], false);
  assert.equal('raw' in result.items[0], false);
});

test('detail SELECT is an explicit public projection and returns only allowlisted DTO fields', async () => {
  const statements: string[] = [];
  const queryFn = fakeQuery((sql) => {
    statements.push(sql);
    return sql.includes('bid_history') ? [{ bid: 50_000, observed_at: '2026-10-03T00:00:00Z', secret: 'drop' }] : [lotFixture()];
  });
  const lot = await getLot(17, queryFn);
  assert.ok(lot);
  assert.doesNotMatch(statements[0], /SELECT \*/i);
  assert.equal('raw' in lot, false);
  assert.equal('external_id' in lot, false);
  assert.deepEqual(lot.bid_history, [{ bid: 50_000, observed_at: '2026-10-03T00:00:00Z' }]);
});

test('map SQL caps rows at 1000 but preserves full counts and reports omissions', async () => {
  let sqlSeen = '';
  const fakePoints = Array.from({ length: 1000 }, (_, i) => ({
    k: `${i},0`, lat: i, lon: 0, cidade: null, uf: 'SP', camada: 'patio', n: 1,
    pontos_total: 1003, mapped_lots: 1100, total: 1200, so_cidade: 70, sem_nada: 30,
  }));
  const queryFn = fakeQuery((sql) => {
    sqlSeen = sql;
    return fakePoints;
  });
  const result = await searchLotsMapa({ uf: 'SP' }, queryFn);
  assert.match(sqlSeen, /ORDER BY n DESC, k LIMIT 1000/);
  assert.equal(result.pontos.length, 1000);
  assert.equal(result.total, 1200);
  assert.equal(result.semLocalizacao, 100);
  assert.equal(result.soCidade, 70);
  assert.equal(result.semNada, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.omittedPoints, 3);
  assert.equal(result.omittedLots, 100);
  assert.equal('id' in result.pontos[0], false);
});

test('facet failures wait for every started query before rejecting', async () => {
  let completed = 0;
  const queryFn = fakeQuery((sql) => {
    if (sql.includes('SELECT COUNT(*)::int AS count FROM lots')) return [{ count: 0 }];
    if (sql.includes('SELECT id, source_id, lot_url')) return [];
    if (!sql.includes('GROUP BY 1')) return [];
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        completed++;
        if (sql.includes('seller_type AS value')) reject(new Error('fixture facet error'));
        else resolve([]);
      }, sql.includes('seller_type AS value') ? 1 : 8);
    });
  });
  await assert.rejects(searchLots({ page: 1 }, queryFn), /fixture facet error/);
  assert.equal(completed, 10);
});

test('internal normalization rejects non-boolean values without coercion', () => {
  const bad = { q: 'ok', onlyWithPhoto: 'true' } as unknown as SearchParams;
  // HTTP strings are parsed at parseSearchInput; typed internal callers must use booleans.
  assert.throws(() => parseSearchInput({ onlyWithPhoto: ['true'] }), BoundedInputError);
  assert.throws(() => normalizeSearchParams(bad), BoundedInputError);
});
