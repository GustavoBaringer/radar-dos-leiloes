import { type ReactNode, useCallback } from 'react';
import type { Lot } from '@/lib/types';
import { LABEL_DOC, LABEL_PROPERTY, LABEL_VEHICLE, SRC_LABEL } from '@/lib/labels';
import { img, money, nopicDe, titulo, whenLabel } from '@/lib/format';

/**
 * Um cartão de lote só, para a busca e para os lotes encontrados por alerta.
 *
 * Ele já nasceu duplicado uma vez na versão vanilla e as cópias divergiram em
 * silêncio: uma ficou sem crédito de foto, sem selo de desconto e com o id
 * interno ("vlance") no lugar do nome da fonte. Quem mexer no cartão mexe aqui.
 */

const TITULO_DESCONTO = (d: number) =>
  `Lance ${d}% abaixo da avaliação publicada pela fonte. Avaliação não é preço de venda, ` +
  `e lance de abertura não é preço de arremate.`;

/** Rede, origem fora do ar ou formato recusado: o cartão precisa mostrar algo. */
function aoFalharImagem(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.fallback === 'yes') return; // guard contra laço se o nopic falhar
  el.dataset.fallback = 'yes';
  el.classList.add('is-nopic');
  el.src = '/nopic.svg';
}

function linhaMeta(lot: Lot): string[] {
  const local = [...new Set([lot.city, lot.state].filter(Boolean))].join('/');
  return [
    lot.asset_type === 'imovel'
      // O tipo classificado vence a categoria crua: a Caixa manda 'apartamento'
      // minúsculo e o vlance manda 'imovel' para tudo.
      ? (LABEL_PROPERTY[lot.property_type ?? ''] ?? lot.source_category ?? 'Imóvel')
      : lot.vehicle_type && lot.vehicle_type !== 'carro'
        ? LABEL_VEHICLE[lot.vehicle_type]
        : null,
    lot.year_model ? `${lot.year_make ?? ''}${lot.year_make ? '/' : ''}${lot.year_model}` : null,
    lot.km != null ? `${lot.km.toLocaleString('pt-BR')} km` : null,
    lot.area ? `${lot.area} m²` : null,
    lot.rooms ? `${lot.rooms} qto${lot.rooms > 1 ? 's' : ''}` : null,
    local || null,
  ].filter((v): v is string => Boolean(v));
}

interface Props {
  lot: Lot;
  aoAbrir: (id: number) => void;
  /** Lance que chegou pelo WebSocket, sobrepondo o do último fetch. */
  lanceAoVivo?: number;
  piscando?: boolean;
  destaque?: boolean;
  rodape?: ReactNode;
}

export function LotCard({ lot, aoAbrir, lanceAoVivo, piscando, destaque, rodape }: Props) {
  const foto = lot.photos?.[0] ?? null;
  const lance = lanceAoVivo ?? lot.current_bid ?? lot.min_bid;
  const when = whenLabel(lot);
  const temDesconto = lot.discount_pct != null && lot.discount_pct > 0 && !lot.bid_suspect;
  const abrir = useCallback(() => aoAbrir(lot.id), [aoAbrir, lot.id]);

  return (
    <article
      className={`card${piscando ? ' flash' : ''}${destaque ? ' hit-novo' : ''}`}
      data-id={lot.id}
      data-fim={lot.auction_end_utc ?? undefined}
      tabIndex={0}
      role="button"
      aria-label={`${titulo(lot)}. ${lance != null ? money(lance) : 'sem lance publicado'}. ${when.text}`}
      onClick={abrir}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          abrir();
        }
      }}
    >
      <div className="thumb">
        <img
          loading="lazy"
          className={foto ? '' : 'is-nopic'}
          src={foto ? img(foto, 640) : nopicDe(lot)}
          data-fallback={foto ? undefined : 'yes'}
          onError={aoFalharImagem}
          alt={foto ? `Foto do lote ${titulo(lot)}` : 'Lote sem foto disponível'}
        />
        <span className="src">{SRC_LABEL[lot.source_id] ?? lot.source_id}</span>
        {lot.is_novo && <span className="novo">novo</span>}
        {lot.doc_type && <span className="badge-doc">{LABEL_DOC[lot.doc_type] ?? lot.doc_type}</span>}
        <div className="rodape-foto">
          {lot.auctioneer_name && (
            <span className="cred-foto" title={`Foto publicada por ${lot.auctioneer_name}`}>
              foto: {lot.auctioneer_name}
            </span>
          )}
          {temDesconto && (
            <span className="disc" title={TITULO_DESCONTO(lot.discount_pct!)}>
              -{lot.discount_pct}%
            </span>
          )}
        </div>
      </div>
      <div className="card-body">
        <div className="title">{titulo(lot)}</div>
        <div className="meta">
          {linhaMeta(lot).map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
        <div className="bid">
          {lance != null ? (
            <>
              <span className="v">{money(lance)}</span>
              <span className="lbl">{lot.current_bid != null || lanceAoVivo != null ? 'lance atual' : 'lance mínimo'}</span>
            </>
          ) : (
            <span className="lbl">sem lance publicado</span>
          )}
          {lot.appraisal != null && !lot.bid_suspect && lance != null && lot.appraisal > lance && (
            <span className="appraisal">{money(lot.appraisal)}</span>
          )}
        </div>
        {lot.bid_suspect && (
          <div className="suspect" title="Valor publicado pela fonte fora de faixa plausível">
            valor atípico na fonte
          </div>
        )}
        <div className={`when ${when.cls}`}>{when.text}</div>
        {rodape}
      </div>
    </article>
  );
}
