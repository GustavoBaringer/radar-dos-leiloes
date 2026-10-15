import type { query as DbQuery } from '../../core/db.js';
import type { Identidade } from '../../domain/identity/identidade.js';

export interface RadarHttpDependencies {
  data: {
    query: typeof DbQuery;
    searchLots: typeof import('../../core/repo.js').searchLots;
    searchLotsMapa: typeof import('../../core/repo.js').searchLotsMapa;
    getLot: typeof import('../../core/repo.js').getLot;
    getStats: typeof import('../../core/repo.js').getStats;
    ensureSources: typeof import('../../core/repo.js').ensureSources;
    contarCasaveis: typeof import('../../core/alerts.js').contarCasaveis;
    avaliarAlertas: typeof import('../../core/alerts.js').avaliarAlertas;
  };
  identity: {
    garantirUsuario: import('../../application/services/identity/identity.service.js').IdentityService['garantirUsuario'];
    identidadePorSub: import('../../application/services/identity/identity.service.js').IdentityService['identidadePorSub'];
    usuarioDoPortao: import('../../application/services/identity/identity.service.js').IdentityService['usuarioDoPortao'];
    ANONIMO: Identidade;
  };
  oidc: {
    oidcLigado: () => boolean;
    iniciarLogin: typeof import('../../infra/auth/oidc.adapter.js').iniciarLogin;
    concluirLogin: typeof import('../../infra/auth/oidc.adapter.js').concluirLogin;
    loginPorSenha: typeof import('../../infra/auth/oidc.adapter.js').loginPorSenha;
    urlDeLogout: typeof import('../../infra/auth/oidc.adapter.js').urlDeLogout;
    COOKIE_OIDC: string;
    COOKIE_PKCE: string;
  };
  jobs: {
    connectors: typeof import('../../connectors/index.js').connectors;
    createCollectQueue: (connection: ReturnType<typeof import('../../queue/runtime.js').makeRedis>) => ReturnType<typeof import('../../queue/runtime.js').createCollectQueue>;
  };
  runtime: {
    makeRedis: typeof import('../../queue/runtime.js').makeRedis;
    createAntibotRedis: (url: string) => ReturnType<typeof import('../../queue/runtime.js').makeRedis>;
    createWsRedis: (url: string) => ReturnType<typeof import('../../queue/runtime.js').makeRedis>;
    CHANNEL_UPDATES: typeof import('../../queue/runtime.js').CHANNEL_UPDATES;
    hostsTlsIncomplete: Set<string>;
    createAntibotDriver?: (config: import('../../core/antibot/types.js').AntibotConfig) => import('../../core/antibot/types.js').RateLimitDriver;
    initialize: () => Promise<void>;
    close: () => Promise<void>;
  };
}

export interface RadarHttpPaths {
  projectRoot: string;
  webRoot: string;
  appDist: string;
  certDir: string;
  dataDir: string;
}

export interface RadarHttpOptions {
  env: NodeJS.ProcessEnv;
  paths: RadarHttpPaths;
  dependencies: RadarHttpDependencies;
}
