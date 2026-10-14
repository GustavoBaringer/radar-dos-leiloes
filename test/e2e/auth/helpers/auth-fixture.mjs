export function authDependencies({ attempts = 0 } = {}) {
  const state = { identities: [], passwordCalls: [], callbackCalls: [], startCalls: [], logoutCalls: [], redis: {}, ensure: 0, redisClients: 0 };
  const oidc = {
    oidcLigado: () => true,
    COOKIE_OIDC: 'radar_oidc', COOKIE_PKCE: 'radar_pkce',
    iniciarLogin: async (redirectUri, destino) => {
      state.startCalls.push({ redirectUri, destino });
      return { url: `https://idp.test/authorize?state=fixture-state`, cookie: 'fixture-pkce-cookie' };
    },
    concluirLogin: async input => {
      state.callbackCalls.push(input);
      if (input.code !== 'valid-code' || input.state !== 'fixture-state' || input.cookiePkce !== 'fixture-pkce-cookie') throw new Error('invalid state or PKCE');
      return { sub: 'verified-sub', email: 'verified@example.test', nome: 'Verified User', papel: 'admin', destino: state.startCalls.at(-1)?.destino ?? '/busca' };
    },
    loginPorSenha: async (usuario, senha) => {
      state.passwordCalls.push({ usuario, senha });
      return usuario === 'valid-user' && senha === 'valid-password'
        ? { sub: 'verified-sub', email: 'verified@example.test', nome: 'Verified User', papel: 'admin' }
        : null;
    },
    urlDeLogout: async redirectUri => { state.logoutCalls.push(redirectUri); return `https://idp.test/logout?return=${encodeURIComponent(redirectUri)}`; },
  };
  const deps = {
    data: { query: async () => { throw new Error('unexpected auth SQL'); }, searchLots: async () => [], searchLotsMapa: async () => ({}), getLot: async () => null, getStats: async () => ({}), ensureSources: async () => { state.ensure++; }, contarCasaveis: async () => 0, avaliarAlertas: async () => [] },
    identity: {
      ANONIMO: { userId: 0, sub: null, email: null, nome: null, papel: 'comum' },
      identidadePorSub: async () => null, usuarioDoPortao: async () => null,
      garantirUsuario: async identity => { state.identities.push(identity); return { userId: 77, ...identity }; },
    },
    oidc,
    jobs: { connectors: [], createCollectQueue: () => { throw new Error('unexpected queue'); } },
    runtime: {
      makeRedis: () => {
        state.redisClients++;
        const client = { status: 'wait', connect: async () => { client.status = 'ready'; },
          get: async key => String(state.redis[key] ?? attempts),
          incr: async key => { state.redis[key] = Number(state.redis[key] ?? 0) + 1; return state.redis[key]; },
          expire: async () => 1, del: async key => { delete state.redis[key]; return 1; },
          quit: async () => 'OK', disconnect: () => { client.status = 'end'; } };
        return client;
      },
      createAntibotRedis: () => { throw new Error('unexpected antibot Redis'); }, createWsRedis: () => { throw new Error('unexpected ws Redis'); },
      CHANNEL_UPDATES: 'updates', hostsTlsIncomplete: new Set(), initialize: async () => {}, close: async () => {},
    },
  };
  return { deps, state };
}
