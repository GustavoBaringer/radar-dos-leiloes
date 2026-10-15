import type { RadarHttpDependencies } from '../infra/http/http-contracts.js';

/** Production composition for the native Nest host; no legacy-host dependency. */
export async function createNativeHttpDependencies(
  oidc: typeof import('../infra/auth/oidc.adapter.js'),
): Promise<RadarHttpDependencies> {
  if (!oidc.oidcLigado()) throw new Error('FATAL: OIDC desligado. Configure OIDC_ISSUER no ambiente.');
  const [repo, db, identity, alerts, connectors, queues, connectorHttp] = await Promise.all([
    import('../core/repo.js'), import('../core/db.js'), import('./identity-composition.js'),
    import('../core/alerts.js'), import('../connectors/index.js'), import('../queue/runtime.js'),
    import('../connectors/http.js'),
  ]);
  return {
    data: { ...repo, ...db, ...alerts },
    identity: identity.defaultIdentityService,
    oidc,
    jobs: { connectors: connectors.connectors, createCollectQueue: queues.createCollectQueue },
    runtime: {
      makeRedis: queues.makeRedis,
      createAntibotRedis: queues.makeAntibotRedis,
      createWsRedis: queues.makeWsRedis,
      CHANNEL_UPDATES: queues.CHANNEL_UPDATES,
      hostsTlsIncomplete: connectorHttp.HOSTS_TLS_INCOMPLETO,
      initialize: async () => {},
      close: () => db.pool.end(),
    },
  };
}
