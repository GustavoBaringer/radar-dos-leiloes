import type { TenantAttempt, TenantObserver } from '../../../core/tenant-attempts.js';

/** Open before population selection, close after persistence, even if the adapter never starts. */
export async function guaranteedTenantObserver(observer: TenantObserver, domain: string) {
  const root = await observer.start(domain);
  let responses = 0;
  let closed = false;
  let summary: Parameters<TenantAttempt['finish']>[0] | undefined;
  const deferred: TenantAttempt = {
    response(status) { if (!closed) { responses++; root.response(status); } },
    failure(kind) { if (!closed) root.failure(kind); },
    async finish(stats) { if (!closed) summary = stats; },
  };
  return {
    observer: {
      async start(requested: string) {
        if (requested.toLowerCase().replace(/^www\./, '') !== domain) throw new Error('Daily adapter crossed tenant boundary');
        return deferred;
      },
    } satisfies TenantObserver,
    async finish(result?: { fetched: number; skipped: number; lots: unknown[]; httpStatus?: number; note?: string }, error?: unknown) {
      closed = true;
      if (responses === 0 && result?.httpStatus && result.httpStatus >= 100) root.response(result.httpStatus);
      if (error) {
        const kind = (error as { kind?: string })?.kind;
        root.failure(kind === 'deadline' ? 'budget' : kind === 'shutdown' || kind === 'lock_lost' ? 'network' : 'parser');
      }
      await root.finish({
        fetched: result?.fetched ?? summary?.fetched ?? 0,
        skipped: result?.skipped ?? summary?.skipped ?? 0,
        returned: result?.lots.length ?? summary?.returned ?? 0,
        truncated: summary?.truncated || Boolean(result?.note),
      });
    },
  };
}
