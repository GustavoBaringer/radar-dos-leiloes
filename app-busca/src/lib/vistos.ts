import type { Lot } from './types';
import { rotuloLance, titulo } from './format';

/** O que basta para desenhar o atalho sem refazer a busca: o lote pode até ter saído da lista. */
export interface Visto {
  id: number;
  titulo: string;
  foto: string | null;
  lance: number | null;
  rotulo: string;
}

const CHAVE = 'radar:vistos';
const EVENTO = 'radar:vistos';
const MAX = 6;

// localStorage pode lançar (aba anônima, cota, site bloqueado): o atalho é conveniência, nunca erro.
export function lerVistos(): Visto[] {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE) ?? '[]');
    return Array.isArray(v) ? v.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function registrarVisto(lot: Lot): void {
  const novo: Visto = {
    id: lot.id,
    titulo: titulo(lot),
    foto: lot.photos?.[0] ?? null,
    lance: lot.current_bid ?? lot.min_bid,
    rotulo: rotuloLance(lot),
  };
  try {
    const lista = [novo, ...lerVistos().filter((x) => x.id !== lot.id)].slice(0, MAX);
    localStorage.setItem(CHAVE, JSON.stringify(lista));
    window.dispatchEvent(new Event(EVENTO));
  } catch {
    /* sem armazenamento, sem atalho */
  }
}

export function ouvirVistos(fn: () => void): () => void {
  window.addEventListener(EVENTO, fn);
  return () => window.removeEventListener(EVENTO, fn);
}
