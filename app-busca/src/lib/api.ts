import type { AccountSummary, Alerta, Favorito, Hit, Lot, PaginatedResponse, RespostaMapa, SearchResponse, Stats } from './types';

/**
 * Cliente da API. Um lugar só para `credentials` e para o tratamento de erro,
 * porque a busca inteira depende de cookie de sessão: um fetch sem ele responde
 * 401 e a tela ficaria em esqueleto para sempre, com o contador antigo no lugar
 * — dando a impressão de que havia resultado.
 */
export class ApiError extends Error {
  constructor(public status: number, mensagem: string, public retryAfterSeconds?: number) {
    super(mensagem);
  }
}

function legacyPage<T>(value: PaginatedResponse<T> | T[], page: number): PaginatedResponse<T> {
  return Array.isArray(value)
    ? { items: value, page, pageSize: 24, hasMore: false }
    : value;
}

/** A casca pode vir do cache do service worker após a sessão expirar. Nesse
 * caso o servidor responde 401 à API; sem este gate o usuário fica numa tela
 * parcial com erro em vez de voltar ao login. */
function redirecionaSeNaoAutenticado(status: number) {
  if (status !== 401 || typeof window === 'undefined' || window.location.pathname === '/login') return;
  const de = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(`/login?de=${encodeURIComponent(de)}`);
}

async function get<T>(url: string, sinal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', signal: sinal });
  redirecionaSeNaoAutenticado(res.status);
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, retryAfter(res));
  return res.json() as Promise<T>;
}

async function envia<T>(url: string, metodo: string, corpo?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers: corpo ? { 'content-type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dado = await res.json().catch(() => ({}) as any);
  redirecionaSeNaoAutenticado(res.status);
  if (!res.ok) throw new ApiError(res.status, dado?.error ?? dado?.erro ?? `HTTP ${res.status}`, retryAfter(res, dado));
  return dado as T;
}

function retryAfter(res: Response, body?: { retryAfterSeconds?: unknown }): number | undefined {
  const seconds = Number(body?.retryAfterSeconds ?? res.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export const api = {
  buscar: (qs: string, sinal?: AbortSignal) => get<SearchResponse>(`/api/search?${qs}`, sinal),
  mapa: (qs: string, sinal?: AbortSignal) => get<RespostaMapa>(`/api/search/mapa?${qs}`, sinal),
  /** Malha do IBGE. A de município pesa 2,3 MB e só é pedida ao aproximar. */
  malha: <T>(tipo: 'uf' | 'municipio') => get<T>(`/api/malha/${tipo}`),
  lote: (id: number) => get<Lot>(`/api/lot/${id}`),
  stats: () => get<Stats>('/api/stats'),
  eu: () => get<AccountSummary>('/api/me'),

  alertas: (page = 1, sinal?: AbortSignal) => get<PaginatedResponse<Alerta>>(`/api/alerts?page=${page}&pageSize=24`, sinal).then((r) => legacyPage(r, page)),
  hits: (page = 1, sinal?: AbortSignal, alertId?: number) => get<PaginatedResponse<Hit>>(`/api/alerts/hits?page=${page}&pageSize=24${alertId === undefined ? '' : `&alertId=${alertId}`}`, sinal).then((r) => legacyPage(r, page)),
  marcarHitsVistos: (alertId?: number) => envia<unknown>('/api/alerts/hits/seen', 'POST', alertId === undefined ? undefined : { alertId }),
  criarAlerta: (corpo: unknown) => envia<{ no_indice_agora?: number }>('/api/alerts', 'POST', corpo),
  // PATCH e não PUT: o servidor aceita só rótulo, canais e e-mail (server.ts:821).
  editarAlerta: (id: number, corpo: unknown) => envia<unknown>(`/api/alerts/${id}`, 'PATCH', corpo),
  apagarAlerta: (id: number) => envia<unknown>(`/api/alerts/${id}`, 'DELETE'),

  favoritos: (page = 1, sinal?: AbortSignal) => get<PaginatedResponse<Favorito>>(`/api/favorites?page=${page}&pageSize=24`, sinal).then((r) => legacyPage(r, page)),
  favoritar: (lotId: number) => envia<unknown>('/api/favorites', 'POST', { lotId }),
  desfavoritar: (lotId: number) => envia<unknown>(`/api/favorites/${lotId}`, 'DELETE'),

  chavePush: () => get<{ publicKey: string | null }>('/api/push/key'),
  inscreverPush: (sub: unknown) => envia<unknown>('/api/push/subscribe', 'POST', sub),
};
