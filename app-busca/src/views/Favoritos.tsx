import { useEffect, useState } from 'react';
import type { Favorito } from '@/lib/types';
import { api } from '@/lib/api';
import { LotCard } from '@/components/LotCard';

interface Props {
  aoAbrirLote: (id: number) => void;
  toast: (t: string) => void;
  /** Sobe quando um lote é favoritado/desfavoritado fora daqui (busca, gaveta). */
  versao: number;
  aoDesfavoritar: (id: number) => void;
}

export function Favoritos({ aoAbrirLote, toast, versao, aoDesfavoritar }: Props) {
  const [favoritos, setFavoritos] = useState<Favorito[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api
      .favoritos()
      .then((f) => { setFavoritos(f); setErro(null); })
      .catch((e) => setErro(String((e as Error)?.message ?? e)));
  }, [versao]);

  function remover(id: number) {
    setFavoritos((antes) => antes?.filter((f) => f.id !== id) ?? antes);
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
      ) : favoritos.length === 0 ? (
        <div className="empty">Nenhum favorito ainda. Clique na estrela de um lote para guardá-lo aqui.</div>
      ) : (
        <div className="grade">
          {favoritos.map((f) => (
            <LotCard
              key={f.id}
              lot={f}
              aoAbrir={aoAbrirLote}
              favoritado
              aoFavoritar={() => { remover(f.id); toast('Removido dos favoritos.'); }}
            />
          ))}
        </div>
      )}
    </main>
  );
}
