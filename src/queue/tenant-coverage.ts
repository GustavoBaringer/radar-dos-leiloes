export const TENANT_COVERAGE = [
  { sourceId: 'soleon', domain: 'realizaleiloes.com.br' },
  { sourceId: 'soleon', domain: 'rjleiloes.com.br' },
  { sourceId: 'soleon', domain: 'lancese.com.br' },
  { sourceId: 'soleon', domain: 'argleiloes.com.br' },
  { sourceId: 'suporteleiloes', domain: 'abaleiloes.com.br' },
  { sourceId: 'suporteleiloes', domain: 'marcotulioleiloes.com.br' },
  { sourceId: 'htmlagenda', domain: 'c3leiloes.com.br' },
  { sourceId: 'htmlagenda', domain: 'leiloescostaesilva.com.br' },
  { sourceId: 'htmlagenda', domain: 'tbaracajuleiloes.com.br' },
  { sourceId: 'leiloesfreire', domain: 'leiloesfreire.com.br' },
  { sourceId: 'vlance', domain: 'fabiobarbosaleiloes.com.br' },
  { sourceId: 'soleon', domain: 'cassianoleiloes.com.br' },
  { sourceId: 'soleon', domain: 'leilaopernambuco.com.br' },
  { sourceId: 'soleon', domain: 'aragaoleiloes.com.br' },
  { sourceId: 'soleon', domain: 'colodeteleiloes.com.br' },
  { sourceId: 'soleon', domain: 'patiorochaleiloes.com.br' },
  { sourceId: 'leiloar', domain: 'flaviocostaleiloes.com.br' },
  { sourceId: 'vlance', domain: 'jdleiloes.com.br' },
  { sourceId: 'vlance', domain: 'joserodovalholeiloes.com.br' },
] as const;
export const TENANT_DEFAULT_TIMEOUT_MS = 600_000;

/** Snapshot's 20 requested domains; only entries in TENANT_COVERAGE are executable. */
export const REQUESTED_COVERAGE_DOMAINS20 = [
  { domain: 'lancecertoleiloes.com.br', status: 'pending', reason: 'connector identity/contract unconfirmed' },
  { domain: 'leiloesfreire.com.br', status: 'configured', sourceId: 'leiloesfreire' },
  { domain: 'cassianoleiloes.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'gracieleiloes.com.br', status: 'pending', reason: 'single-tenant adapter pending' },
  { domain: 'leilaopernambuco.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'rjleiloes.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'ghvmleiloes.com.br', status: 'pending', reason: 'auctioneer/source association unconfirmed' },
  { domain: 'inovaleilao.com.br', status: 'pending', reason: 'single-tenant adapter pending' },
  { domain: 'flaviocostaleiloes.com.br', status: 'configured', sourceId: 'leiloar' },
  { domain: 'aragaoleiloes.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'coliseumleiloes.com.br', status: 'pending', reason: 'individual parser probe pending' },
  { domain: 'jdleiloes.com.br', status: 'configured', sourceId: 'vlance' },
  { domain: 'albuquerqueleiloes.com.br', status: 'pending', reason: 'individual parser probe pending' },
  { domain: 'portaldosleiloes.com.br', status: 'pending', reason: 'Suporte v2 adapter pending' },
  { domain: 'ericosobral.com.br', status: 'pending', reason: 'connector identity/contract unconfirmed' },
  { domain: 'colodeteleiloes.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'joserodovalholeiloes.com.br', status: 'configured', sourceId: 'vlance' },
  { domain: 'leiloesbrasilpe.com.br', status: 'pending', reason: 'individual parser probe pending' },
  { domain: 'patiorochaleiloes.com.br', status: 'configured', sourceId: 'soleon' },
  { domain: 'vlleiloes.com.br', status: 'pending', reason: 'Suporte v2 adapter pending' },
] as const;

export const LEGACY_TENANT_SCHEDULER_IDS = [
  'collect-tenant-soleon-realizaleiloes-com-br',
  'collect-tenant-soleon-rjleiloes-com-br',
  'collect-tenant-soleon-lancese-com-br',
  'collect-tenant-soleon-argleiloes-com-br',
  'collect-tenant-suporteleiloes-abaleiloes-com-br',
  'collect-tenant-suporteleiloes-marcotulioleiloes-com-br',
  'collect-tenant-htmlagenda-c3leiloes-com-br',
  'collect-tenant-htmlagenda-leiloescostaesilva-com-br',
  'collect-tenant-htmlagenda-tbaracajuleiloes-com-br',
  'collect-tenant-leiloesfreire-leiloesfreire-com-br',
  'collect-tenant-vlance-fabiobarbosaleiloes-com-br',
] as const;

export const COVERAGE_UNION_SIZE = 29;

export function isTenantCoveragePair(sourceId: string, domain: string): boolean {
  return TENANT_COVERAGE.some((item) => item.sourceId === sourceId && item.domain === domain);
}

export function assertTenantCoveragePair(sourceId: string, domain: string): void {
  if (typeof domain !== 'string' || !domain.trim() || !isTenantCoveragePair(sourceId, domain)) {
    throw new Error(`Invalid reviewed tenant pair: ${sourceId}/${domain}`);
  }
}

export function tenantExecutionOptions(sourceId: string, tenant: string) {
  assertTenantCoveragePair(sourceId, tenant);
  return { tenant, forceTenantObserver: true, job: 'collect:tenant' as const };
}

export async function assertTenantSourceIsEnabled(sourceId: string, lookup: (sourceId: string) => Promise<boolean>) {
  if (!await lookup(sourceId)) throw new Error(`Source is disabled or unregistered: ${sourceId}`);
}

export function tenantCoverageForSource(sourceId: string) {
  return TENANT_COVERAGE.filter((item) => item.sourceId === sourceId);
}

export function coverageReadiness() {
  const configured = new Set<string>(TENANT_COVERAGE.map((item) => item.domain));
  const requested = REQUESTED_COVERAGE_DOMAINS20.filter((item) => !configured.has(item.domain));
  return { requested: REQUESTED_COVERAGE_DOMAINS20.length, configured: TENANT_COVERAGE.length,
    union: new Set([...TENANT_COVERAGE.map((item) => item.domain), ...REQUESTED_COVERAGE_DOMAINS20.map((item) => item.domain)]).size,
    pending: requested.map((item) => ({ domain: item.domain, reason: 'reason' in item ? item.reason : 'coverage pair pending' })) };
}

export function tenantScheduleItems(allowedSources?: ReadonlySet<string>, timeoutOverrides: Readonly<Record<string, number>> = {}) {
  return TENANT_COVERAGE.map(({ sourceId, domain }, index) => ({ sourceId,
    id: `collect-tenant-${sourceId}-${domain.replaceAll('.', '-')}`,
    name: `collect:tenant:${sourceId}:${domain}`,
    pattern: `${[7, 13, 18][index % 3]} 7,13,18 * * *`,
    data: { sourceId, limit: 1200, tenant: domain, timeoutMs: timeoutOverrides[sourceId] ?? TENANT_DEFAULT_TIMEOUT_MS },
  })).filter((item) => !allowedSources || allowedSources.has(item.sourceId));
}

export interface SchedulerQueue {
  upsertJobScheduler(id: string, repeat: { pattern: string; tz: string }, template: { name: string; data: unknown; opts: { attempts: number; removeOnComplete: number; removeOnFail: number } }): Promise<unknown>;
}

/** Upsert only owned tenant schedulers; never remove/replace unrelated jobs. */
export async function registerTenantSchedulers(queue: SchedulerQueue, timezone = 'America/Sao_Paulo', allowedSources?: ReadonlySet<string>, timeoutOverrides: Readonly<Record<string, number>> = {}) {
  for (const item of tenantScheduleItems(allowedSources, timeoutOverrides)) {
    await queue.upsertJobScheduler(item.id, { pattern: item.pattern, tz: timezone }, {
      name: item.name,
      data: item.data,
      opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
    });
  }
}

export function isTenantSchedulerId(id: string): boolean {
  return tenantScheduleItems().some((item) => item.id === id);
}

export async function migrateLegacyTenantSchedulers(
  legacyQueue: { removeJobScheduler(id: string): Promise<unknown> },
  snapshot: any,
  registerNew: () => Promise<unknown>,
) {
  const redis = snapshot?.redis;
  const schedulers = redis?.schedulers;
  if (redis?.schedulerCount !== 59 || redis?.sourceSchedulerCount !== 48 || redis?.tenantSchedulerCount !== 11 ||
      !Array.isArray(schedulers) || schedulers.length !== 59) {
    throw new Error('Legacy migration requires the verified 59-scheduler preflight snapshot');
  }
  const keys = new Set(schedulers.map((item: any) => item?.key));
  if (!LEGACY_TENANT_SCHEDULER_IDS.every((id) => keys.has(id))) {
    throw new Error('Preflight snapshot does not contain all 11 exact legacy tenant scheduler IDs');
  }
  await registerNew();
  for (const id of LEGACY_TENANT_SCHEDULER_IDS) await legacyQueue.removeJobScheduler(id);
}
