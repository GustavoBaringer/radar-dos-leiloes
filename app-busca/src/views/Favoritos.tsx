import { useEffect, useState } from 'react';
import type { Favorito } from '@/lib/types';
import type { FavoriteReadStamp } from '@/lib/favorite-context';
import { api } from '@/lib/api';
import { LotCard } from '@/components/LotCard';
import { Paginacao } from '@/components/Paginacao';

interface Props {
  aoAbrirLote: (id: number) => void;
  toast: (t: string) => void;
  /** Sobe quando um lote é favoritado/desfavoritado fora daqui (busca, gaveta). */
  versao: number;
  aoDesfavoritar: (id: number) => void;
  aoConhecerLotes: (lotes: Favorito[], stamp?: FavoriteReadStamp) => void;
  iniciarLeituraFavoritos: () => FavoriteReadStamp;
}

export function Favoritos({ aoAbrirLote, toast, versao, aoDesfavoritar, aoConhecerLotes, iniciarLeituraFavoritos }: Props) {
  const [favoritos, setFavoritos] = useState<{ items: Favorito[]; page: number; hasMore: boolean } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    const favoriteStamp = iniciarLeituraFavoritos();
    setLoading(true);
    api.favoritos(page, ac.signal)
      .then((f) => {
        if (!f.items.length && page > 1) { setPage(page - 1); return; }
        aoConhecerLotes(f.items, favoriteStamp);
        setFavoritos(f); setErro(null);
      })
      .catch((e) => { if (!ac.signal.aborted) setErro(String((e as Error)?.message ?? e)); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [versao, page, aoConhecerLotes]);

  function remover(id: number) {
    setFavoritos((antes) => antes ? { ...antes, items: antes.items.filter((f) => f.id !== id) } : antes);
    aoDesfavoritar(id);
  }

  return (
    <main className="faixa sec">
      <h1 className="page-head">Favoritos</h1>
      <p className="page-sub">
        Lotes que você guardou para achar de novo — a estrela do cartão ou da página do lote
        adiciona e remove daqui.
      </p>

      {erro ? (
        <div className="empty">Não foi possível carregar os favoritos ({erro}).</div>
      ) : !favoritos ? (
        <div className="empty">Carregando…</div>
      ) : favoritos.items.length === 0 ? (
        <div className="empty">Nenhum favorito ainda. Clique na estrela de um lote para guardá-lo aqui.</div>
      ) : (
        <div className="grade">
          {favoritos.items.map((f) => (
            <LotCard
              key={f.id}
              lot={f}
              aoAbrir={aoAbrirLote}
              favoritado={true}
              aoFavoritar={() => { remover(f.id); toast('Removido dos favoritos.'); }}
            />
          ))}
        </div>
      )}
      {favoritos && <Paginacao label="Páginas de favoritos" page={favoritos.page} hasMore={favoritos.hasMore} loading={loading} onPage={setPage} />}
    </main>
  );
}
