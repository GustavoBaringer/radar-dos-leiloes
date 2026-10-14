export const lot = {
  id: 42, source_id: 'fixture', lot_url: 'https://auction.example/lote/42', title_raw: 'Honda Civic 2018 CRLV fixture',
  title_display: 'Honda Civic 2018', brand: 'Honda', model: 'Civic', version: 'EX', year_make: 2018, year_model: 2018,
  km: 50000, color: 'preto', fuel: 'flex', plate_masked: 'ABC****', doc_type: 'CRLV', closing_model: 'timer_por_lote',
  auction_start_utc: null, auction_end_utc: null, source_tz: 'internal-timezone', status: 'aberto', current_bid: 20000,
  min_bid: 18000, bid_increment: 500, appraisal: 30000, fees_pct: null, bid_suspect: false, asset_type: 'veiculo',
  vehicle_type: 'carro', property_type: null, source_category: 'carro', auctioneer_name: 'Fixture Leilões', auctioneer_reg: null,
  area: null, rooms: null, seller_name: 'Internal Person Secret', seller_type: 'pessoa', yard: null, city: 'São Paulo', state: 'SP',
  photos: [], photo_count: 0, financeable: null, has_report: null, collected_at: 'internal-collection-secret',
  first_seen_at: 'internal-first-seen-secret', is_novo: false, effective_status: 'aberto', discount_pct: 33,
  raw: { documento: 'raw-private-document-secret' },
};

export function pagesDependencies({ missingLot = false, lotFailure = false } = {}) {
  const state = { getLotCalls: [], queries: [], ensured: 0 };
  const deps = {
    data: {
      query: async (sql, params = []) => {
        state.queries.push({ sql, params });
        if (sql.startsWith('SELECT lot_id FROM favorites WHERE owner_id')) return [];
        throw new Error(`unexpected page SQL: ${sql}`);
      },
      searchLots: async () => { throw Error('unexpected searchLots'); }, searchLotsMapa: async () => { throw Error('unexpected searchLotsMapa'); },
      getLot: async (id, options) => { state.getLotCalls.push({ id, options }); if (lotFailure) throw new Error('private db failure'); return missingLot ? null : lot; },
      getStats: async () => { throw Error('unexpected getStats'); }, ensureSources: async () => { state.ensured++; },
      contarCasaveis: async () => 0, avaliarAlertas: async () => [],
    },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async sub => ({ userId: sub === 'fixture-user' ? 18 : 19, sub, email: 'fixture@example.test', nome: 'Fixture User', papel: 'comum' }),
      usuarioDoPortao: async papel => ({ userId: 18, sub: null, email: 'fixture@example.test', nome: 'Fixture User', papel }),
      garantirUsuario: async () => { throw Error('unexpected garantirUsuario'); },
    },
    oidc: { oidcLigado: () => true, iniciarLogin: async () => { throw Error('unexpected OIDC start'); }, concluirLogin: async () => { throw Error('unexpected OIDC callback'); }, loginPorSenha: async () => null, urlDeLogout: async () => null, COOKIE_OIDC: 'radar_oidc', COOKIE_PKCE: 'radar_pkce' },
    jobs: { connectors: [], createCollectQueue: () => { throw Error('unexpected queue'); } },
    runtime: {
      makeRedis: () => { throw Error('unexpected Redis'); }, createAntibotRedis: () => { throw Error('unexpected antibot Redis'); }, createWsRedis: () => { throw Error('unexpected ws Redis'); },
      CHANNEL_UPDATES: 'updates', hostsTlsIncomplete: new Set(), initialize: async () => {}, close: async () => {},
    },
  };
  return { deps, state };
}
