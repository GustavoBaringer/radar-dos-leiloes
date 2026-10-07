/**
 * Dependências estritas do host legado para testes de contrato: nenhuma
 * chamada fora da lista abaixo acontece sem lançar erro de fixture.
 * Compartilhado entre o contrato do host e o piloto Nest de marcas.
 */
export const BRANDS_SQL = 'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC';
export const PHOTO_HOSTS_SQL = /SELECT split_part\(split_part\(p, ':/;

export function dependencies({ queryFailure = false, identityDeleted = false, startupFailure = false, mode = 'off', injectDriver = true } = {}) {
  const state = { queries: [], init: 0, closes: 0, queueClosed: 0, ensured: 0, redis: 0, connected: 0, subscribed: 0, queueCreated: 0, driverChecks: [], identityLookups: 0, antibotUrl: '', wsUrl: '', antibotRedisConnected: 0, antibotRedisClosed: 0, protectionClosed: 0 };
  const deps = {
    data: {
      query: async (sql) => {
        state.queries.push(sql);
        if (sql === BRANDS_SQL) {
          if (queryFailure && state.queries.filter((seen) => seen === BRANDS_SQL).length === 1) throw new Error('db secret detail');
          return [{ brand: 'FORD', count: 2 }];
        }
        if (PHOTO_HOSTS_SQL.test(sql)) return [];
        throw new Error(`unexpected SQL in host test: ${sql}`);
      },
      searchLots: async () => { throw Error('unexpected searchLots'); },
      searchLotsMapa: async () => { throw Error('unexpected searchLotsMapa'); },
      getLot: async () => { throw Error('unexpected getLot'); },
      getStats: async () => { throw Error('unexpected getStats'); },
      ensureSources: async () => { state.ensured++; if (startupFailure) throw Error('startup fixture'); },
      contarCasaveis: async () => { throw Error('unexpected contarCasaveis'); },
      avaliarAlertas: async () => { throw Error('unexpected avaliarAlertas'); },
    },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async (sub) => { state.identityLookups++; return identityDeleted ? null : ({ userId: 7, sub, email: 'a@b.test', nome: 'Test', papel: 'admin' }); },
      usuarioDoPortao: async (papel) => ({ userId: 7, sub: null, email: 'a@b.test', nome: 'Test', papel }),
      garantirUsuario: async () => { throw Error('unexpected garantirUsuario'); },
    },
    oidc: {
      oidcLigado: () => true,
      iniciarLogin: async () => { throw Error('unexpected iniciarLogin'); },
      concluirLogin: async () => { throw Error('unexpected concluirLogin'); },
      loginPorSenha: async () => { throw Error('unexpected loginPorSenha'); },
      urlDeLogout: async () => null,
      COOKIE_OIDC: 'radar_oidc', COOKIE_PKCE: 'radar_pkce',
    },
    jobs: {
      connectors: [],
      createCollectQueue: (connection) => { state.queueCreated++; if (!connection) throw Error('queue connection required'); return { add: async () => { throw Error('unexpected queue.add'); }, close: async () => { state.queueClosed++; } }; },
    },
    runtime: {
      makeRedis: () => {
        const index = state.redis++;
        if (index > 2) throw Error('unexpected Redis client');
        const client = {
          status: 'wait',
          connect: async () => { state.connected++; client.status = 'ready'; return 'OK'; },
          get: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected get'); return null; },
          incr: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected incr'); return 1; },
          expire: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected expire'); return 1; },
          del: async (key) => { if (!key.startsWith('login:falha:')) throw Error('unexpected del'); return 1; },
          subscribe: async (channel) => { if (channel !== 'lot-updates') throw Error('unexpected subscribe'); state.subscribed++; client.status = 'ready'; },
          on: (event, listener) => { if (!['message', 'error'].includes(event) || typeof listener !== 'function') throw Error('unexpected Redis listener'); },
          quit: async () => 'OK', disconnect: () => { client.status = 'end'; },
        };
        return client;
      }, CHANNEL_UPDATES: 'lot-updates',
      // Fixture: never touches a real Redis. The host owns this client, so quit/disconnect
      // must happen exactly once at app.close.
      createAntibotRedis: (url) => {
        state.antibotUrl = url;
        const client = {
          status: 'wait',
          connect: async () => { state.antibotRedisConnected++; client.status = 'ready'; return 'OK'; },
          on: (event, listener) => { if (event !== 'error' || typeof listener !== 'function') throw Error('unexpected antibot Redis listener'); },
          defineCommand: (name) => {
            if (name !== 'rateLimit') throw Error('unexpected antibot Redis command');
            client[name] = (_key, timeWindow, _max, _continue, _backoff, cb) => cb(null, [1, timeWindow]);
          },
          quit: async () => { state.antibotRedisClosed++; client.status = 'end'; return 'OK'; },
          disconnect: () => { state.antibotRedisClosed++; client.status = 'end'; },
        };
        return client;
      },
      createWsRedis: (url) => { state.wsUrl = url; const client = { status: 'wait', connect: async () => { state.connected++; client.status = 'ready'; return 'OK'; }, on: (event, listener) => { if (event !== 'error' || typeof listener !== 'function') throw Error('unexpected ws Redis listener'); }, eval: async () => 1, quit: async () => 'OK', disconnect: () => { client.status = 'end'; } }; return client; },
      hostsTlsIncomplete: new Set(),
      initialize: async () => { state.init++; },
      close: async () => { state.closes++; },
      ...(mode === 'off' || !injectDriver ? {} : { createAntibotDriver: () => ({ check: async (policy) => { state.driverChecks.push(policy.id); return { allowed: policy.id !== 'search' && policy.id !== 'vitrine', ttlMs: 1_500 }; }, ping: async () => {}, close: async () => { state.protectionClosed++; } }) }),
    },
  };
  return { deps, state };
}
