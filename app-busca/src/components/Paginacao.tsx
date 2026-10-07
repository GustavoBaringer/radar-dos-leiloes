interface Props {
  page: number;
  hasMore: boolean;
  loading?: boolean;
  onPage: (page: number) => void;
  label: string;
}

export function Paginacao({ page, hasMore, loading = false, onPage, label }: Props) {
  const capped = page >= 100 && hasMore;
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
      <span className="pageinfo mono" aria-live="polite">Página {page}{capped ? ' (limite de 100 páginas)' : ''}</span>
      <button type="button" disabled={loading || !hasMore || page >= 100} onClick={() => onPage(page + 1)}>Próxima</button>
      {capped && <span className="pageinfo">Existem mais resultados, mas a navegação está limitada a 100 páginas.</span>}
    </nav>
  );
}
