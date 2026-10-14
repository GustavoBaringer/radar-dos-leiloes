import { afterEach, describe, expect, it } from '@jest/globals';
import { CatalogService, CatalogServiceError } from '../../../dist/src/application/services/catalog/catalog.service.js';
import { CatalogRepository } from '../../../dist/src/infra/database/repositories/catalog.repository.js';
import { BRAND_LIST } from '../../../dist/src/domain/lots/normalize.js';

const user = { userId: 314, papel: 'comum' };
const admin = { userId: 1, papel: 'admin' };
const lotRow = (id = 83) => ({
  id, source_id: 'fixture-source', lot_url: 'https://example.test/lot/83', title_raw: 'Honda Civic 2020',
  title_display: 'Honda Civic', brand: 'Honda', model: 'Civic', version: null, year_make: 2020, year_model: 2020,
  km: null, doc_type: null, closing_model: 'timer_por_lote', auction_start_utc: null, auction_end_utc: null,
  status: 'aberto', current_bid: 100, min_bid: null, bid_increment: null, appraisal: null, fees_pct: null,
  bid_suspect: false, asset_type: 'veiculo', vehicle_type: 'carro', property_type: null, source_category: null,
  auctioneer_name: null, auctioneer_reg: null, area: null, rooms: null, seller_name: null, seller_type: null,
  yard: null, city: null, state: null, photos: [], photo_count: 0, financeable: null, has_report: null,
  collected_at: new Date('2026-10-01T00:00:00Z'), first_seen_at: new Date('2026-10-01T00:00:00Z'),
  is_novo: false, effective_status: 'aberto', discount_pct: null, color: 'Prata', fuel: 'Flex', plate_masked: null,
});

function setup() {
  const calls = [];
  let searchRows = [lotRow()];
  let detailRows = [lotRow()];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT brand, COUNT(*)::int AS count')) return [{ brand: 'Honda', count: 1 }];
    if (sql.startsWith('SELECT COUNT(*)::int AS count FROM lots')) return [{ count: 1 }];
    if (sql.startsWith('SELECT lot_id FROM favorites')) return params[0] === user.userId && params[1].includes(83) ? [{ lot_id: 83 }] : [];
    if (sql.includes('FROM bid_history WHERE lot_id=$1')) return [{ bid: '100.00', observed_at: new Date('2026-10-01T00:00:00Z') }];
    if (sql.includes('FROM lots WHERE id = $1')) return detailRows;
    if (sql.includes('FROM lots') && sql.includes('discount_pct') && sql.includes('LIMIT') && !sql.includes('GROUP BY')) return searchRows;
    if (sql.includes('AS value, COUNT(*)::int AS count') && sql.includes('FROM lots')) return [];
    if (sql.includes('FROM lots') && sql.includes('auctioneer_site_name') && sql.includes('COUNT(*)::int AS count')) return [];
    if (sql.includes('octet_length(city)')) return [];
    if (sql.includes('COUNT(DISTINCT brand)::int AS marcas')) return [{ lots: 1, abertos: 1 }];
    if (sql.includes('FROM lots l JOIN sources')) return [];
    if (sql.includes('FROM collection_runs')) return [];
    if (sql.includes('FROM sources s LEFT JOIN lots')) return [{ id: 'fixture-source', lots: 1 }];
    throw new Error(`Unexpected catalog SQL: ${sql}`);
  };
  const repository = new CatalogRepository(query);
  return { calls, query, repository, service: new CatalogService(repository, query), setSearchRows: (rows) => { searchRows = rows; }, setDetailRows: (rows) => { detailRows = rows; } };
}

describe('CatalogService', () => {
  let fixture;
  afterEach(() => { fixture = undefined; });

  it('rejects unauthenticated actors and invalid input before any repository query', async () => {
    fixture = setup();
    await expect(fixture.service.search({}, undefined)).rejects.toMatchObject({ statusCode: 401 });
    await expect(fixture.service.detail(0, user)).rejects.toMatchObject({ statusCode: 400 });
    await expect(fixture.service.homeLeiloeiro('  ', user)).rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.calls).toHaveLength(0);
  });

  it('preserves brands known/present envelope and guards sources/stats before query', async () => {
    fixture = setup();
    const brands = await fixture.service.brands(user);
    expect(brands).toEqual({ known: BRAND_LIST, present: [{ brand: 'Honda', count: 1 }] });
    expect(() => fixture.service.stats(user)).toThrow(CatalogServiceError);
    expect(() => fixture.service.sources(user)).toThrow(CatalogServiceError);
    expect(fixture.calls).toHaveLength(1);

    expect(await fixture.service.sources(admin)).toEqual([{ id: 'fixture-source', lots: 1 }]);
    expect((await fixture.service.stats(admin)).totals.lots).toBe(1);
    expect(fixture.calls.some(({ sql }) => sql.includes('FROM sources s LEFT JOIN lots'))).toBe(true);
  });

  it('returns search envelope and decorates favorites for the authenticated owner only', async () => {
    fixture = setup();
    const result = await fixture.service.search({ q: 'civic', page: 1, pageSize: 12 }, user);
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 12, items: [{ id: 83, favorited: true }] });
    expect(result.facets).toHaveProperty('states');
    const favoriteCall = fixture.calls.find(({ sql }) => sql.startsWith('SELECT lot_id FROM favorites'));
    expect(favoriteCall.params).toEqual([user.userId, [83]]);
  });

  it('returns the public detail projection and applies owner-scoped favorite decoration', async () => {
    fixture = setup();
    const result = await fixture.service.detail(83, user);
    expect(result).toMatchObject({ id: 83, favorited: true, color: 'Prata', bid_history: [{ bid: 100 }] });
    expect(result).not.toHaveProperty('source_tz');
    expect(fixture.calls.find(({ sql }) => sql.startsWith('SELECT lot_id FROM favorites')).params[0]).toBe(user.userId);

    const adminResult = await fixture.service.detail(83, admin);
    expect(adminResult).toHaveProperty('source_tz');
  });
});
