import { isIP } from 'node:net';

export interface TenantAttempt {
  response(status: number): void;
  /**
   * `budget` é exclusivo de cancelamento por prazo da coleta (deadline): o
   * finish grava state `failed` + error_kind `budget`. Shutdown/lock_lost entram
   * como `network` e seguem a regra de falha de rede. Nenhum valor novo no banco.
   */
  failure(kind?: 'network' | 'parser' | 'budget'): void;
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

export function normalizeTenantDomain(value: string): string {
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

export function validateTenantObserverContext(context: TenantObserverContext): void {
  if (!context || !Number.isSafeInteger(context.runId) || context.runId <= 0 ||
      typeof context.sourceId !== 'string' || !context.sourceId.trim() || context.sourceId.length > 80 ||
      !['cron', 'refresh', 'manual', 'unknown'].includes(context.origin) ||
      (context.jobId !== undefined && (typeof context.jobId !== 'string' || context.jobId.length > 200)) ||
      (context.scheduledAt !== undefined && (!(context.scheduledAt instanceof Date) || !Number.isFinite(context.scheduledAt.getTime())))) {
    throw new Error('Invalid tenant observer context');
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface TenantAttemptOutcome {
  state: 'failed' | 'partial' | 'completed';
  fetched: number;
  skipped: number;
  returned: number;
  latestStatus: number | null;
  responses: number;
  errorKind: 'network' | 'parser' | 'budget' | 'http' | 'no_response' | null;
}

/** In-memory validation/counters only; completion is acknowledged after successful persistence. */
export class TenantAttemptState {
  private responses = 0;
  private latestStatus: number | null = null;
  private badHttp = false;
  private failureKind: 'network' | 'parser' | 'budget' | null = null;
  private finished = false;

  private ensureOpen(): void { if (this.finished) throw new Error('Tenant attempt already finished'); }

  response(status: number): void {
    this.ensureOpen();
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Invalid HTTP status');
    this.responses++;
    this.latestStatus = status;
    if (status < 200 || status >= 300) this.badHttp = true;
  }

  failure(kind: 'network' | 'parser' | 'budget' = 'network'): void {
    this.ensureOpen();
    this.failureKind = kind;
  }

  prepareFinish(stats: Parameters<TenantAttempt['finish']>[0]): TenantAttemptOutcome {
    this.ensureOpen();
    if (!stats || !validCount(stats.fetched) || !validCount(stats.skipped) || !validCount(stats.returned) ||
        (stats.truncated !== undefined && typeof stats.truncated !== 'boolean')) {
      throw new Error('Invalid tenant attempt stats');
    }
    const cancelado = this.failureKind === 'budget';
    const failed = this.failureKind !== null || this.badHttp;
    const state = cancelado ? 'failed'
      : failed ? (stats.fetched > 0 || stats.returned > 0 ? 'partial' : 'failed')
      : stats.truncated ? 'partial' : this.responses === 0 ? 'failed' : 'completed';
    const errorKind = this.failureKind ?? (this.badHttp ? 'http' : stats.truncated ? 'budget' : this.responses === 0 ? 'no_response' : null);
    return { state, fetched: stats.fetched, skipped: stats.skipped, returned: stats.returned,
      latestStatus: this.latestStatus, responses: this.responses, errorKind };
  }

  complete(): void { this.finished = true; }
}
