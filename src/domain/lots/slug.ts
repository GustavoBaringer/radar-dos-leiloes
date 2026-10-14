/** Campos usados pelos produtores de links da landing e do app. */
export interface LoteParaSlug {
  id: number | string;
  brand?: string | null;
  model?: string | null;
  year_model?: number | string | null;
  doc_type?: string | null;
  source_id?: string | null;
  title_display?: string | null;
  title_raw?: string | null;
}

/** O slug identifica a URL canônica; não substitui autorização. */
export function slugDoLote(lot: LoteParaSlug): string {
  const base =
    [lot.brand, lot.model, lot.year_model, lot.doc_type, lot.source_id].filter(Boolean).join(' ') ||
    lot.title_display || lot.title_raw || 'lote';
  const texto = String(base)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
  return `${texto || 'lote'}-${lot.id}`;
}

export function idDoSlug(slug: string): number | null {
  const match = /^[a-z0-9]+(?:-[a-z0-9]+)*-([1-9]\d*)$/.exec(slug);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
