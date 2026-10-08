import type { Connector, CollectResult } from '../connectors/types.js';
import type { UpsertOutcome } from './repo.js';
import type { TenantObserverContext } from './tenant-attempts.js';
import {
  collectionSignal,
  erroDeCancelamento,
  throwIfAborted,
  throwIfCancelled,
  withCollectionCancellation,
} from './collection-cancellation.js';

export type CollectionMetadata = Pick<TenantObserverContext, 'origin' | 'jobId' | 'scheduledAt'>;
export type CollectionRunData = { ok: boolean; fetched?: number; upserted?: number; skipped?: number; error?: string; httpStatus?: number };
export type CollectionNotifications = { disparos: number; push: number; emails: number; pendentesEmail: number };

export interface CollectionExecutionOptions {
  sourceId: string;
  limit: number;
  job?: string;
  metadata?: CollectionMetadata;
  signal?: AbortSignal;
  timeoutMs?: number;
  checkEmptyHttpFailure?: boolean;
  authorizePersistence?: () => void | Promise<void>;
  /** Optional worker-only bid/collect event hook; called after successful finishRun. */
  publish?: (event: { type: 'bids'; changes: UpsertOutcome['bidChanges'] } | { type: 'collect'; sourceId: string; fetched: number; upserted: number; skipped: number }) => Promise<unknown>;
}

export interface CollectionExecutionDependencies {
  lookupConnector: (sourceId: string) => Connector | undefined;
  startRun: (sourceId: string, job: string, limit: number) => Promise<number>;
  finishRun: (runId: number, data: CollectionRunData) => Promise<unknown>;
  upsertLots: (lots: CollectResult['lots']) => Promise<UpsertOutcome>;
  observerForCollection: (context: { runId: number; sourceId: string } & CollectionMetadata) => unknown;
  processarAposColeta: (novos: number[], publish?: (payload: unknown) => Promise<unknown>) => Promise<CollectionNotifications>;
  publishNotification?: (payload: unknown) => Promise<unknown>;
  logError?: (message: string, error: unknown) => void;
}

export interface CollectionExecutionResult {
  runId: number;
  result: CollectResult;
  upserted: number;
  bidChanges: UpsertOutcome['bidChanges'];
  notifications: CollectionNotifications;
  publishErrors: string[];
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const safeError = (error: unknown) => errorText(error).replace(/(redis:\/\/|postgres(?:ql)?:\/\/)[^\s]*/gi, '$1[redacted]');

/**
 * Conectores cooperativos abortam sozinhos (o fetch e os checkpoints leem o
 * sinal). Este race é a rede de segurança para os que ignoram o sinal — parse
 * CPU-bound ou promise pendurada: sem ele um prazo de coleta nunca derrubaria
 * um `collect` que não completa.
 */
function comPrazo<T>(sinal: AbortSignal | undefined, promessa: Promise<T>): Promise<T> {
  if (!sinal) return promessa;
  if (sinal.aborted) {
    promessa.catch(() => undefined);
    return Promise.reject(erroDeCancelamento(sinal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const limpar = () => sinal.removeEventListener('abort', abortar);
    const abortar = () => {
      limpar();
      promessa.catch(() => undefined);
      reject(erroDeCancelamento(sinal.reason));
    };
    sinal.addEventListener('abort', abortar, { once: true });
    promessa.then(
      (valor) => { limpar(); resolve(valor); },
      (erro) => { limpar(); reject(erro); },
    );
  });
}

/** Shared collection flow. Once persistence starts, cancellation cannot interrupt bookkeeping. */
export async function executeCollection(
  options: CollectionExecutionOptions,
  deps: CollectionExecutionDependencies,
): Promise<CollectionExecutionResult> {
  const runId = await deps.startRun(options.sourceId, options.job ?? 'collect', options.limit);
  let finished = false;
  const finish = async (data: CollectionRunData) => {
    if (finished) return;
    finished = true;
    await deps.finishRun(runId, data);
  };
  let result: CollectResult | undefined;
  let upserted = 0;
  let bidChanges: UpsertOutcome['bidChanges'] = [];
  let notifications: CollectionNotifications = { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 };

  try {
    const connector = deps.lookupConnector(options.sourceId);
    if (!connector) throw new Error(`fonte desconhecida: ${options.sourceId}`);
    const metadata = options.metadata ?? { origin: 'unknown' as const };
    const observer = deps.observerForCollection({ runId, sourceId: options.sourceId, ...metadata });
    result = await withCollectionCancellation({ signal: options.signal, timeoutMs: options.timeoutMs }, () => {
      throwIfCancelled();
      const coleta = connector.collect({ limit: options.limit, ...(observer ? { observer: observer as never } : {}) });
      return comPrazo(collectionSignal(), coleta);
    });
    throwIfAborted(options.signal);
    if (options.checkEmptyHttpFailure && result.fetched === 0 && result.httpStatus != null && (result.httpStatus < 200 || result.httpStatus >= 300)) {
      const error = new Error(`${options.sourceId} devolveu HTTP ${result.httpStatus} sem nenhum lote`) as Error & { httpStatus: number };
      error.httpStatus = result.httpStatus;
      throw error;
    }
    await options.authorizePersistence?.();
    throwIfAborted(options.signal);

    // Persistence begins here: finish all post-write bookkeeping even if a signal arrives.
    const upsert = await deps.upsertLots(result.lots);
    upserted = upsert.upserted;
    bidChanges = upsert.bidChanges;
    notifications = await deps.processarAposColeta(upsert.novos, deps.publishNotification);
    await finish({ ok: true, fetched: result.fetched, upserted, skipped: result.skipped, httpStatus: result.httpStatus });

    const publishErrors: string[] = [];
    if (options.publish) {
      const events = [
        ...(bidChanges.length ? [{ type: 'bids' as const, changes: bidChanges }] : []),
        { type: 'collect' as const, sourceId: options.sourceId, fetched: result.fetched, upserted, skipped: result.skipped },
      ];
      for (const event of events) {
        try { await options.publish(event); }
        catch (error) { publishErrors.push(safeError(error)); deps.logError?.('collection event publish failed', error); }
      }
    }
    return { runId, result, upserted, bidChanges, notifications, publishErrors };
  } catch (error) {
    const httpStatus = Number((error as { httpStatus?: unknown } | null)?.httpStatus) || undefined;
    try {
      await finish({ ok: false, fetched: result?.fetched, upserted, skipped: result?.skipped, httpStatus, error: safeError(error) });
    } catch (finishError) {
      deps.logError?.('collection finishRun failed', finishError);
      throw finishError;
    }
    throw error;
  }
}
