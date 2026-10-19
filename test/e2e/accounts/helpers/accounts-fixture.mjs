export function accountDependencies({ throttleCount = 1 } = {}) {
  const state = { queries: [], writes: [], ensured: 0, redisClients: 0 };
  const deps = {
    data: {
      query: async (sql, params = []) => {
        state.queries.push({ sql, params });
        if (sql.startsWith('SELECT count(*)::int AS total FROM alerts')) return [{ total: 0 }];
        if (sql.includes('FROM alert_hits h') && sql.includes('JOIN alerts a')) return [{ count: 0 }];
        if (sql.includes('FROM favorites f') && sql.includes('JOIN lots l') && sql.startsWith('SELECT count(*)::int AS count')) return [{ count: 0 }];
        if (sql.includes('FROM alerts a WHERE a.owner_id')) return [];
        if (sql.startsWith('SELECT count(*)::int AS total FROM favorites')) return [{ total: 0 }];
        if (sql.includes('FROM favorites f JOIN lots l')) return [];
        if (sql.includes('FROM push_subscriptions WHERE owner_id')) return [];
        if (sql.includes('INSERT INTO cadastros')) { state.writes.push({ sql, params }); return []; }
        if (sql.includes('INSERT INTO espera')) { state.writes.push({ sql, params }); return []; }
        if (sql.includes('INSERT INTO favorites')) { state.writes.push({ sql, params }); return []; }
        if (sql.includes('INSERT INTO push_subscriptions')) { state.writes.push({ sql, params }); return []; }
        if (sql.includes('INSERT INTO alerts')) { state.writes.push({ sql, params }); return [{ id: 1, label: params[0], q: params[1], filters: {}, channels: params[3], email: params[4] }]; }
        throw new Error(`unexpected account SQL: ${sql}`);
      },
      searchLots: async () => { throw Error('unexpected searchLots'); }, searchLotsMapa: async () => { throw Error('unexpected searchLotsMapa'); },
      getLot: async () => { throw Error('unexpected getLot'); }, getStats: async () => { throw Error('unexpected getStats'); },
      ensureSources: async () => { state.ensured++; }, contarCasaveis: async () => 0, avaliarAlertas: async () => [],
    },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async sub => ({ userId: sub === 'user-two' ? 22 : 11, sub, email: `${sub}@test.invalid`, nome: 'Fixture User', papel: 'comum' }),
      usuarioDoPortao: async papel => ({ userId: 11, sub: null, email: 'one@test.invalid', nome: 'Fixture User', papel }),
      garantirUsuario: async () => { throw Error('unexpected garantirUsuario'); },
    },
    oidc: { oidcLigado: () => true, iniciarLogin: async () => { throw Error('unexpected'); }, concluirLogin: async () => { throw Error('unexpected'); }, loginPorSenha: async () => { throw Error('unexpected'); }, urlDeLogout: async () => null, COOKIE_OIDC: 'oidc', COOKIE_PKCE: 'pkce' },
    jobs: { connectors: [], createCollectQueue: () => { throw Error('unexpected queue'); } },
    runtime: {
      makeRedis: () => {
        state.redisClients++;
        const client = { status: 'wait', connect: async () => { client.status = 'ready'; }, incr: async () => Array.isArray(throttleCount) ? throttleCount.shift() ?? 1 : throttleCount, expire: async () => 1, quit: async () => 'OK', disconnect: () => { client.status = 'end'; } };
        return client;
      },
      createAntibotRedis: () => { throw Error('unexpected antibot Redis'); }, createWsRedis: () => { throw Error('unexpected ws Redis'); }, CHANNEL_UPDATES: 'updates', hostsTlsIncomplete: new Set(),
      initialize: async () => {}, close: async () => {},
    },
  };
  return { deps, state };
}
