import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Cancelamento cooperativo da coleta (lane A).
 *
 * `withCollectionCancellation` cria um AbortController PRÓPRIO (nunca os sinais
 * do processo) e o publica no AsyncLocalStorage. Quem roda dentro lê o sinal com
 * `collectionSignal()`/`combinedSignal()` — o HTTP compartilhado e o fetch
 * nativo passam a abortar juntos — e marca pontos de verificação com
 * `throwIfCancelled()` entre hosts/páginas/itens.
 *
 * Teto conhecido: laço CPU-bound não é interrompível no meio de um parse — o
 * checkpoint é cooperativo. Upgrade, se um dia precisar: rodar o parse em worker
 * thread com terminate.
 */
export type CollectionCancelKind = 'deadline' | 'shutdown' | 'lock_lost';

export class CollectionCancellationError extends Error {
  readonly kind: CollectionCancelKind;
  constructor(kind: CollectionCancelKind, message?: string) {
    super(message ?? `coleta cancelada (${kind})`);
    this.name = 'CollectionCancellationError';
    this.kind = kind;
  }
}

interface Contexto {
  signal: AbortSignal;
  controller: AbortController;
  deadlineMs: number | null;
}

const als = new AsyncLocalStorage<Contexto>();

export interface CollectionCancellationOptions {
  /** Sinal externo (shutdown do worker, perda de lock). Motivo com `.kind` vira o `kind` do erro. */
  signal?: AbortSignal;
  /** Prazo total da coleta em ms. 0 (ou ausente) desliga o prazo. */
  timeoutMs?: number;
}

/** Normaliza qualquer motivo de abort num CollectionCancellationError. */
export function erroDeCancelamento(
  reason: unknown,
  fallback: CollectionCancelKind = 'shutdown',
): CollectionCancellationError {
  if (reason instanceof CollectionCancellationError) return reason;
  const k = (reason as { kind?: unknown } | null | undefined)?.kind;
  const kind: CollectionCancelKind = k === 'deadline' || k === 'shutdown' || k === 'lock_lost' ? k : fallback;
  const message = reason instanceof Error ? reason.message : undefined;
  return new CollectionCancellationError(kind, message);
}

/**
 * Executa `fn` com um contexto de cancelamento próprio. `timeoutMs` aborta com
 * kind `deadline`; `signal` externo aborta com o kind do motivo (padrão
 * `shutdown`). Aninhado no contexto de outra coleta, herda o cancelamento do
 * pai (a "cadeia"). Limpa timer e listeners ao terminar, sucesso ou erro.
 */
export async function withCollectionCancellation<T>(
  options: CollectionCancellationOptions | null | undefined,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const controller = new AbortController();
  const timeoutMs = Number(options?.timeoutMs ?? 0);
  const externo = options?.signal;
  const pai = als.getStore();

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new CollectionCancellationError('deadline')), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  }
  const doExterno = () => controller.abort(erroDeCancelamento(externo?.reason));
  const doPai = () => controller.abort(erroDeCancelamento(pai?.signal.reason));
  if (externo) {
    if (externo.aborted) doExterno();
    else externo.addEventListener('abort', doExterno, { once: true });
  }
  if (pai) {
    if (pai.signal.aborted) doPai();
    else pai.signal.addEventListener('abort', doPai, { once: true });
  }

  const limpar = () => {
    if (timer !== undefined) clearTimeout(timer);
    externo?.removeEventListener('abort', doExterno);
    pai?.signal.removeEventListener('abort', doPai);
  };

  const ctx: Contexto = { signal: controller.signal, controller, deadlineMs: timeoutMs > 0 ? timeoutMs : null };
  try {
    return await als.run(ctx, fn);
  } finally {
    limpar();
  }
}

/** Sinal da coleta atual, se houver contexto. Fora dele: undefined (sem cancelamento). */
export function collectionSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}

/** Prazo total configurado (ms) na coleta atual, ou null quando não há prazo/contexto. */
export function collectionDeadlineMs(): number | null {
  return als.getStore()?.deadlineMs ?? null;
}

/** Lança CollectionCancellationError se o sinal dado já abortou. Síncrono. */
export function throwIfAborted(signal: AbortSignal | undefined, kind?: CollectionCancelKind): void {
  if (!signal?.aborted) return;
  throw erroDeCancelamento(signal.reason, kind ?? 'shutdown');
}

/** Ponto de verificação: lança se a coleta atual foi cancelada. Síncrono. Fora do contexto não faz nada. */
export function throwIfCancelled(kind?: CollectionCancelKind): void {
  const ctx = als.getStore();
  if (!ctx) return;
  throwIfAborted(ctx.signal, kind);
}

/**
 * Sinal efetivo de uma chamada: contexto da coleta + sinal do chamador, quando
 * existem os dois. Sem contexto devolve o do chamador — comportamento antigo.
 */
export function combinedSignal(extra?: AbortSignal): AbortSignal | undefined {
  const coleta = collectionSignal();
  if (!coleta) return extra;
  if (!extra || extra === coleta) return coleta;
  if (coleta.aborted) return coleta;
  if (extra.aborted) return extra;
  return AbortSignal.any([extra, coleta]);
}
