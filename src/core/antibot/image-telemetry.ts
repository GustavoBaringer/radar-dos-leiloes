/** Bounded image metrics; minute summaries contain no IPs, accounts or image URLs. */
export function createImageTelemetry(options: {
  clock?: () => number;
  emit?: (summary: { minuteUtc: string } & Record<string, unknown>) => void;
  maxClients?: number;
} = {}) {
  const clock = options.clock ?? Date.now;
  const maxClients = options.maxClients ?? 10_000;
  const clients = new Map<string, number>();
  const blank = () => ({ requests: 0, completed: 0, cacheHits: 0, cacheMisses: 0,
    rateLimited: 0, overloaded: 0, failed: 0, placeholders: 0, durationMsTotal: 0, durationMsMax: 0,
    durationBuckets: { lt50ms: 0, lt200ms: 0, lt1000ms: 0, lt3000ms: 0, ge3000ms: 0 } });
  let minute = Math.floor(clock() / 60_000);
  let current = blank();
  const total = blank();
  let peakRequests = 0;
  let peakClientRequests = 0;
  let clientsOmitted = 0;
  const summary = () => ({ minuteUtc: new Date(minute * 60_000).toISOString(), ...current, durationBuckets: { ...current.durationBuckets },
    maxRequestsPerClient: Math.max(0, ...clients.values()), clientsOmitted });
  function flush(force = false) {
    const next = Math.floor(clock() / 60_000);
    if (!force && next === minute) return;
    if (current.requests || current.completed) {
      try { options.emit?.(summary()); } catch { /* metrics never interrupt a request */ }
    }
    if (next !== minute) {
      minute = next;
      current = blank();
      clients.clear();
      clientsOmitted = 0;
    }
  }
  function start(client: string): number {
    flush();
    current.requests++; total.requests++;
    if (clients.has(client) || clients.size < maxClients) clients.set(client, (clients.get(client) ?? 0) + 1);
    else clientsOmitted++;
    peakRequests = Math.max(peakRequests, current.requests);
    peakClientRequests = Math.max(peakClientRequests, clients.get(client) ?? 0);
    return clock();
  }
  function complete(startedAt: number, status: number, cache?: unknown, placeholder = false) {
    flush();
    const duration = Math.max(0, clock() - startedAt);
    for (const counters of [current, total]) {
      counters.completed++;
      if (cache === 'hit') counters.cacheHits++;
      if (cache === 'miss') counters.cacheMisses++;
      if (status === 429) counters.rateLimited++;
      if (status === 503) counters.overloaded++;
      if (status >= 400) counters.failed++;
      if (placeholder) counters.placeholders++;
      counters.durationMsTotal += duration;
      counters.durationMsMax = Math.max(counters.durationMsMax, duration);
      const bucket = duration < 50 ? 'lt50ms' : duration < 200 ? 'lt200ms' : duration < 1000 ? 'lt1000ms' : duration < 3000 ? 'lt3000ms' : 'ge3000ms';
      counters.durationBuckets[bucket]++;
    }
  }
  return { start, complete, flush, snapshot: () => {
    flush();
    return { total: { ...total, durationBuckets: { ...total.durationBuckets },
      durationMsAverage: total.completed ? total.durationMsTotal / total.completed : 0,
      cacheHitRatio: total.cacheHits + total.cacheMisses ? total.cacheHits / (total.cacheHits + total.cacheMisses) : 0 },
      currentMinute: summary(), peakRequestsPerMinute: peakRequests, peakRequestsPerClientPerMinute: peakClientRequests,
      window: 'UTC calendar minute', retention: 'process totals; completed minute summaries persisted in service logs' };
  } };
}
