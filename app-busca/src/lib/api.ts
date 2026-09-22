import type { Alerta, Favorito, Hit, Lot, RespostaMapa, SearchResponse, Stats } from './types';

/**
 * Cliente da API. Um lugar só para `credentials` e para o tratamento de erro,
 * porque a busca inteira depende de cookie de sessão: um fetch sem ele responde
 * 401 e a tela ficaria em esqueleto para sempre, com o contador antigo no lugar
 * — dando a impressão de que havia resultado.
 */
export class ApiError extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

async function get<T>(url: string, sinal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', signal: sinal });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
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
  if (!res.ok) throw new ApiError(res.status, dado?.erro ?? `HTTP ${res.status}`);
  return dado as T;
}

export const api = {
  buscar: (qs: string, sinal?: AbortSignal) => get<SearchResponse>(`/api/search?${qs}`, sinal),
  mapa: (qs: string, sinal?: AbortSignal) => get<RespostaMapa>(`/api/search/mapa?${qs}`, sinal),
  /** Malha do IBGE. A de município pesa 2,3 MB e só é pedida ao aproximar. */
  malha: <T>(tipo: 'uf' | 'municipio') => get<T>(`/api/malha/${tipo}`),
  lote: (id: number) => get<Lot>(`/api/lot/${id}`),
  stats: () => get<Stats>('/api/stats'),
  eu: () => get<{ papel?: string }>('/api/me'),

  alertas: () => get<Alerta[]>('/api/alerts'),
  hits: () => get<Hit[]>('/api/alerts/hits'),
  marcarHitsVistos: () => envia<unknown>('/api/alerts/hits/seen', 'POST'),
  criarAlerta: (corpo: unknown) => envia<{ no_indice_agora?: number }>('/api/alerts', 'POST', corpo),
  // PATCH e não PUT: o servidor aceita só rótulo, canais e e-mail (server.ts:821).
  editarAlerta: (id: number, corpo: unknown) => envia<unknown>(`/api/alerts/${id}`, 'PATCH', corpo),
  apagarAlerta: (id: number) => envia<unknown>(`/api/alerts/${id}`, 'DELETE'),

  favoritos: () => get<Favorito[]>('/api/favorites'),
  favoritar: (lotId: number) => envia<unknown>('/api/favorites', 'POST', { lotId }),
  desfavoritar: (lotId: number) => envia<unknown>(`/api/favorites/${lotId}`, 'DELETE'),

  chavePush: () => get<{ publicKey: string | null }>('/api/push/key'),
  inscreverPush: (sub: unknown) => envia<unknown>('/api/push/subscribe', 'POST', sub),
};
