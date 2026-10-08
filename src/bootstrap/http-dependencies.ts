import type { LegacyHostDependencies } from '../legacy-host.js';

/** Production-only composition boundary; never imported by host contract tests. */
export async function createHttpDependencies(oidc: typeof import('../core/oidc.js')): Promise<LegacyHostDependencies> {
  const [repo, db, identity, alerts, connectors, queues, http] = await Promise.all([
    import('../core/repo.js'), import('../core/db.js'), import('../core/identidade.js'),
    import('../core/alerts.js'), import('../connectors/index.js'), import('../queue/runtime.js'),
    import('../connectors/http.js'),
  ]);
  return {
    data: { ...repo, ...db, ...alerts },
    identity,
    oidc,
    jobs: { connectors: connectors.connectors, createCollectQueue: queues.createCollectQueue },
    runtime: {
      makeRedis: queues.makeRedis,
      createAntibotRedis: queues.makeAntibotRedis,
      createWsRedis: queues.makeWsRedis,
      CHANNEL_UPDATES: queues.CHANNEL_UPDATES,
      hostsTlsIncomplete: http.HOSTS_TLS_INCOMPLETO,
      async initialize() {},
      close: () => db.pool.end(),
    },
  };
}
