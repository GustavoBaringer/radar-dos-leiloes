const lot = {
  id: 101, source_id: 'fixture', lot_url: 'https://auction.example/item/101', title_raw: 'Fixture lot', title_display: 'Fixture lot',
  brand: 'FORD', model: 'KA', version: null, year_make: 2020, year_model: 2020, km: 1000, doc_type: 'CRLV',
  closing_model: 'timer_por_lote', auction_start_utc: null, auction_end_utc: null, source_tz: 'private-tz', status: 'aberto',
  current_bid: 100, min_bid: null, bid_increment: null, appraisal: 200, fees_pct: null, bid_suspect: false,
  asset_type: 'veiculo', vehicle_type: 'carro', property_type: null, source_category: 'carro', auctioneer_name: 'Fixture Auction',
  auctioneer_reg: null, area: null, rooms: null, seller_name: 'Private Seller', seller_type: 'pessoa', yard: null,
  city: 'São Paulo', state: 'SP', photos: [], photo_count: 0, financeable: null, has_report: null,
  collected_at: 'secret-collected-at', first_seen_at: 'secret-first-seen-at', is_novo: false, effective_status: 'aberto', discount_pct: 50,
};

export function catalogDependencies({ failBrandsOnce = false, detailMissing = false } = {}) {
  const state = { queries: [], brandsFailed: false, ensured: 0, unexpected: [] };
  const deps = {
    data: {
      query: async (sql, params = []) => {
        state.queries.push({ sql, params });
        if (sql.includes('SELECT brand, COUNT(*)::int AS count FROM lots')) {
          if (failBrandsOnce && !state.brandsFailed) { state.brandsFailed = true; throw new Error('secret database detail'); }
          return [{ brand: 'FORD', count: 4 }];
        }
        if (sql.includes('SELECT lot_id FROM favorites WHERE owner_id')) return [{ lot_id: 101 }];
        if (sql.startsWith('SELECT bid, observed_at FROM bid_history')) return [];
        if (sql.startsWith('SELECT COUNT(*)::int AS count FROM lots')) return [{ count: 1 }];
        if (sql.startsWith('SELECT id, source_id, lot_url') && sql.includes('FROM lots WHERE id = $1')) return detailMissing ? [] : [lot];
        if (sql.startsWith('SELECT id, source_id, lot_url') && sql.includes('FROM lots')) return [lot];
        if (sql.startsWith('SELECT id, title_raw, title_display, source_id, lot_url')) return [lot];
        if (sql.startsWith('SELECT ') && sql.includes(' AS value, COUNT(*)::int AS count') && sql.includes('FROM lots')) return [];
        if (sql.startsWith('SELECT count(DISTINCT source_id)::int AS fontes') && sql.includes('novos24h')) return [{ fontes: 1, total: 1, totalLeiloeiros: 3, novos24h: 1, encerram24h: 0 }];
        if (sql.startsWith('SELECT count(DISTINCT source_id)::int AS fontes')) return [{ fontes: 1, total: 1, totalLeiloeiros: 3 }];
        if (sql.startsWith('SELECT state AS uf')) return [{ uf: 'SP', total: 1 }];
        if (sql.startsWith('SELECT count(*) FILTER (WHERE vehicle_type=')) return [{ c0: 1, c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 }];
        if (sql.startsWith('SELECT DISTINCT ON (cat)')) return [];
        if (sql.startsWith('SELECT h, count(l.id)::int AS total')) return Array.from({ length: 12 }, (_, i) => ({ h: i + 1, total: 0 }));
        if (sql.startsWith('SELECT id, title_display, title_raw')) return [];
        if (sql.startsWith('SELECT auctioneer_name AS nome')) return [];
        if (sql.startsWith('SELECT s.*, COUNT(l.id)::int AS lots')) return [];
        if (sql.startsWith('SELECT COUNT(*)::int AS lots')) return [{ lots: 0 }];
        if (sql.startsWith('SELECT l.source_id, s.name')) return [];
        if (sql.startsWith('SELECT source_id, job, started_at')) return [];
        if (sql.startsWith('SELECT lot_id FROM favorites')) return [];
        state.unexpected.push(sql);
        throw new Error(`unexpected catalog SQL: ${sql}`);
      },
      searchLots: async () => { throw Error('unexpected searchLots'); }, searchLotsMapa: async () => { throw Error('unexpected searchLotsMapa'); },
      getLot: async () => { throw Error('unexpected getLot'); }, getStats: async () => { throw Error('unexpected getStats'); },
      ensureSources: async () => { state.ensured++; }, contarCasaveis: async () => 0, avaliarAlertas: async () => [],
    },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async sub => ({ userId: sub === 'admin-user' ? 99 : sub === 'user-two' ? 22 : 11, sub, email: 'fixture@test.invalid', nome: 'Fixture User', papel: sub === 'admin-user' ? 'admin' : 'comum' }),
      usuarioDoPortao: async papel => ({ userId: 11, sub: null, email: 'fixture@test.invalid', nome: 'Fixture User', papel }),
      garantirUsuario: async () => { throw Error('unexpected garantirUsuario'); },
    },
    oidc: { oidcLigado: () => true, iniciarLogin: async () => { throw Error('unexpected'); }, concluirLogin: async () => { throw Error('unexpected'); }, loginPorSenha: async () => { throw Error('unexpected'); }, urlDeLogout: async () => null, COOKIE_OIDC: 'oidc', COOKIE_PKCE: 'pkce' },
    jobs: { connectors: [], createCollectQueue: () => { throw Error('unexpected queue'); } },
    runtime: {
      makeRedis: () => { throw Error('unexpected Redis'); }, createAntibotRedis: () => { throw Error('unexpected antibot Redis'); }, createWsRedis: () => { throw Error('unexpected ws Redis'); },
      CHANNEL_UPDATES: 'updates', hostsTlsIncomplete: new Set(), initialize: async () => {}, close: async () => {},
    },
  };
  return { deps, state };
}

export { lot };
