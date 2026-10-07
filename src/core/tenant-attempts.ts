import { isIP } from 'node:net';
import { query } from './db.js';

export interface TenantAttempt {
  response(status: number): void;
  failure(kind?: 'network' | 'parser'): void;
  finish(stats: { fetched: number; skipped: number; returned: number; truncated?: boolean }): Promise<void>;
}

export interface TenantObserver {
  start(domain: string): Promise<TenantAttempt>;
}

export interface TenantObserverContext {
  runId: number;
  sourceId: string;
  origin: 'cron' | 'refresh' | 'manual' | 'unknown';
  jobId?: string;
  scheduledAt?: Date;
}

type Execute = (sql: string, params?: any[]) => Promise<any[]>;

function normalizeDomain(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 253 || /[^\x21-\x7e]/.test(value) || /[/:@?#\\]/.test(value)) {
    throw new Error('Invalid tenant domain');
  }
  let host = value.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || host.length > 253 || isIP(host) || !host.includes('.') ||
      host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Invalid tenant domain');
  }
  return new URL(`https://${host}`).hostname;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createTenantObserver(context: TenantObserverContext, execute: Execute = query): TenantObserver {
  if (!context || !Number.isSafeInteger(context.runId) || context.runId <= 0 ||
      typeof context.sourceId !== 'string' || !context.sourceId.trim() || context.sourceId.length > 80 ||
      !['cron', 'refresh', 'manual', 'unknown'].includes(context.origin) ||
      (context.jobId !== undefined && (typeof context.jobId !== 'string' || context.jobId.length > 200)) ||
      (context.scheduledAt !== undefined && (!(context.scheduledAt instanceof Date) || !Number.isFinite(context.scheduledAt.getTime())))) {
    throw new Error('Invalid tenant observer context');
  }

  return {
    async start(rawDomain) {
      const domain = normalizeDomain(rawDomain);
      const rows = await execute(
        `INSERT INTO tenant_collection_attempts (run_id, source_id, domain, origin, job_id, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [context.runId, context.sourceId, domain, context.origin, context.jobId ?? null, context.scheduledAt ?? null],
      );
      const id = Number(rows[0]?.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Could not create tenant attempt');

      let responses = 0;
      let latestStatus: number | null = null;
      let badHttp = false;
      let failureKind: 'network' | 'parser' | null = null;
      let finished = false;
      const ensureOpen = () => { if (finished) throw new Error('Tenant attempt already finished'); };

      return {
        response(status) {
          ensureOpen();
          if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Invalid HTTP status');
          responses++;
          latestStatus = status;
          if (status < 200 || status >= 300) badHttp = true;
        },
        failure(kind = 'network') {
          ensureOpen();
          failureKind = kind;
        },
        async finish(stats) {
          ensureOpen();
          if (!stats || !validCount(stats.fetched) || !validCount(stats.skipped) || !validCount(stats.returned) ||
              (stats.truncated !== undefined && typeof stats.truncated !== 'boolean')) {
            throw new Error('Invalid tenant attempt stats');
          }
          const failed = failureKind !== null || badHttp;
          const state = failed ? (stats.fetched > 0 || stats.returned > 0 ? 'partial' : 'failed')
            : stats.truncated ? 'partial' : responses === 0 ? 'failed' : 'completed';
          const errorKind = failureKind ?? (badHttp ? 'http' : stats.truncated ? 'budget' : responses === 0 ? 'no_response' : null);
          const updated = await execute(
            `UPDATE tenant_collection_attempts
             SET finished_at = now(), state = $2, fetched = $3, skipped = $4, returned = $5,
                 http_status = $6, http_responses = $7, error_kind = $8
             WHERE id = $1 AND state = 'running' RETURNING id`,
            [id, state, stats.fetched, stats.skipped, stats.returned, latestStatus, responses, errorKind],
          );
          if (!updated.length) throw new Error('Tenant attempt is no longer running');
          finished = true;
        },
      };
    },
  };
}
