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
] as const;
export const TENANT_DEFAULT_TIMEOUT_MS = 600_000;

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
