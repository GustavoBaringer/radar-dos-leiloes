import type { Lot } from './types';

/**
 * URL amigável do lote. Aceitamos apenas o slug canônico atual; o ID identifica
 * o lote, mas não é uma autorização para acessá-lo.
 */
export function slugDoLote(lot: Pick<Lot, 'brand' | 'model' | 'year_model' | 'doc_type' | 'source_id' | 'title_display' | 'title_raw' | 'id'>): string {
  const base =
    [lot.brand, lot.model, lot.year_model, lot.doc_type, lot.source_id].filter(Boolean).join(' ') ||
    lot.title_display ||
    lot.title_raw ||
    'lote';
  const texto = String(base)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
  return `${texto || 'lote'}-${lot.id}`;
}

export function idDoSlug(slug: string): number | null {
  const m = /^[a-z0-9]+(?:-[a-z0-9]+)*-([1-9]\d*)$/.exec(String(slug ?? ''));
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
