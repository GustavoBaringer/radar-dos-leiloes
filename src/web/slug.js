/**
 * URL amigável do lote. O id vai no fim de propósito: o texto do slug é enfeite
 * e muda quando a fonte corrige o título, mas o link antigo precisa continuar
 * abrindo o mesmo lote. Resolver por texto exigiria coluna de slug e histórico.
 */
function slugDoLote(lot) {
  const base = [lot.brand, lot.model, lot.year_model, lot.doc_type, lot.source_id]
    .filter(Boolean)
    .join(' ') || lot.title_display || lot.title_raw || 'lote';
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

const idDoSlug = (slug) => {
  const m = /-(\d+)$/.exec(String(slug ?? ''));
  return m ? Number(m[1]) : null;
};
