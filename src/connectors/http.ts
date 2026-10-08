import { request, Agent, interceptors, type Dispatcher } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { combinedSignal } from '../core/collection-cancellation.js';

// Freitas entrega cadeia TLS incompleta (medido: UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// O undici v7 não aceita `connect` no request() direto; só via dispatcher Agent.
let insecureAgent: Agent | null = null;
export function insecureDispatcher(): Agent {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

/**
 * Hosts com cadeia TLS comprovadamente incompleta. Vale para o coletor E para
 * o proxy de imagem: o CDN do Freitas falha com UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * e, sem isto, todas as fotos daquela fonte viravam nopic silenciosamente.
 */
/**
 * `request` do undici NÃO segue redirect por padrão: devolve o 301 e o conector
 * enxerga zero lote sem erro nenhum (foi o que aconteceu com o Leilão PRO, cujos
 * tenants redirecionam para www). O interceptor resolve para todos os conectores.
 */
let redirAgent: Dispatcher | null = null;
function agenteComRedirect(): Dispatcher {
  redirAgent ??= new Agent().compose(interceptors.redirect({ maxRedirections: 4 }));
  return redirAgent;
}

let redirInseguro: Dispatcher | null = null;
function agenteInseguroComRedirect(): Dispatcher {
  redirInseguro ??= new Agent({ connect: { rejectUnauthorized: false } }).compose(
    interceptors.redirect({ maxRedirections: 4 }),
  );
  return redirInseguro;
}

export const HOSTS_TLS_INCOMPLETO = new Set([
  'www.freitasleiloeiro.com.br',
  'freitasleiloeiro.com.br',
  'cdn3.freitasleiloeiro.com.br',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Limite de taxa por HOST, não global: o VIP devolve 429 do Cloudflare
 * depois de ~6 requisições rápidas e a SOLEON derruba a conexão em rajada.
 */
const lastHit = new Map<string, number>();
const DEFAULT_GAP_MS = 1100;

async function waitWithSignal(ms: number, signal?: AbortSignal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err;
  }
}

async function throttle(host: string, gapMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  const now = Date.now();
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + gapMs - now;
  if (wait > 0) await waitWithSignal(wait, signal);
  if (signal?.aborted) throw signal.reason;
  lastHit.set(host, Date.now());
}

export interface FetchOpts {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  gapMs?: number;
  timeoutMs?: number;
  retries?: number;
  /**
   * Desliga a verificação da cadeia TLS. Só para fonte com cadeia comprovadamente
   * incompleta (Freitas). O nome diz o que faz: a flag anterior chamava-se
   * `rejectUnauthorized: true` e DESLIGAVA a verificação, o inverso do padrão
   * do Node — quem fosse copiar para um conector novo deixaria a conexão aberta
   * achando que estava endurecendo.
   */
  insecureTls?: boolean;
  signal?: AbortSignal;
}

export interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const host = new URL(url).host;
  const retries = opts.retries ?? 2;
  // Chamador + sinal da coleta (ALS): cancelamento comum corta throttle, backoff
  // e retry. O prazo por requisição fica separado, para não virar retry-forever.
  const cancel = combinedSignal(opts.signal);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, opts.gapMs ?? DEFAULT_GAP_MS, cancel);
    const prazo = AbortSignal.timeout(opts.timeoutMs ?? 20000);
    const requestSignal = cancel ? AbortSignal.any([cancel, prazo]) : prazo;
    try {
      const res = await request(url, {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
          ...opts.headers,
        },
        body: opts.body,
        headersTimeout: opts.timeoutMs ?? 20000,
        bodyTimeout: opts.timeoutMs ?? 20000,
        signal: requestSignal,
        dispatcher: opts.insecureTls ? agenteInseguroComRedirect() : agenteComRedirect(),
      });
      const body = await res.body.text();
      // 429/503 são transitórios e merecem backoff; 4xx restante é resposta final.
      if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < retries) {
        await waitWithSignal(2000 * (attempt + 1), cancel);
        continue;
      }
      return { status: res.statusCode, body, headers: res.headers as any };
    } catch (err) {
      if (cancel?.aborted) throw cancel.reason;
      lastErr = err;
      if (attempt < retries) await waitWithSignal(1500 * (attempt + 1), cancel);
    }
  }
  throw lastErr ?? new Error(`falha ao buscar ${url}`);
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<{ status: number; data: T | null; raw: string }> {
  const res = await fetchText(url, opts);
  try {
    return { status: res.status, data: JSON.parse(res.body) as T, raw: res.body };
  } catch {
    return { status: res.status, data: null, raw: res.body };
  }
}
