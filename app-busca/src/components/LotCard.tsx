import { type ReactNode, useCallback } from 'react';
import { ArrowUpRight, BedDouble, Calendar, Gauge, Heart, MapPin, Ruler } from 'lucide-react';
import type { Lot } from '@/lib/types';
import { LABEL_ASSET, LABEL_DOC, LABEL_PROPERTY, LABEL_VEHICLE, SRC_LABEL } from '@/lib/labels';
import { contagem, fracaoDaAvaliacao, img, money, nopicDe, rotuloLance, titulo, whenLabel } from '@/lib/format';
import { useAgora } from '@/hooks/useAgora';

/**
 * Um cartão de lote só, para a busca e para os lotes encontrados por alerta.
 *
 * Ele já nasceu duplicado uma vez na versão vanilla e as cópias divergiram em
 * silêncio: uma ficou sem crédito de foto, sem selo de desconto e com o id
 * interno ("vlance") no lugar do nome da fonte. Quem mexer no cartão mexe aqui.
 */

const TITULO_AVALIACAO =
  'Avaliação publicada pela fonte. Avaliação não é preço de venda, e lance de abertura não é preço de arremate.';

/** Rede, origem fora do ar ou formato recusado: o cartão precisa mostrar algo. */
function aoFalharImagem(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.fallback === 'yes') return; // guard contra laço se o nopic falhar
  el.dataset.fallback = 'yes';
  el.classList.add('is-nopic');
  el.src = '/nopic.svg';
}

function tipoDe(lot: Lot): string {
  if (lot.asset_type === 'imovel') {
    // O tipo classificado vence a categoria crua: a Caixa manda 'apartamento'
    // minúsculo e o vlance manda 'imovel' para tudo.
    return LABEL_PROPERTY[lot.property_type ?? ''] ?? lot.source_category ?? 'Imóvel';
  }
  return LABEL_VEHICLE[lot.vehicle_type ?? ''] ?? LABEL_ASSET[lot.asset_type] ?? 'Veículo';
}

function specsDe(lot: Lot): Array<{ ico: ReactNode; txt: string }> {
  const s: Array<{ ico: ReactNode; txt: string }> = [];
  if (lot.year_model) {
    s.push({ ico: <Calendar aria-hidden />, txt: lot.year_make && lot.year_make !== lot.year_model ? `${lot.year_make}/${lot.year_model}` : String(lot.year_model) });
  }
  if (lot.km != null) s.push({ ico: <Gauge aria-hidden />, txt: `${lot.km.toLocaleString('pt-BR')} km` });
  if (lot.area) s.push({ ico: <Ruler aria-hidden />, txt: `${Math.round(lot.area)} m²` });
  if (lot.rooms) s.push({ ico: <BedDouble aria-hidden />, txt: `${lot.rooms} ${lot.rooms > 1 ? 'quartos' : 'quarto'}` });
  const local = [...new Set([lot.city, lot.state].filter(Boolean))].join('/');
  if (local) s.push({ ico: <MapPin aria-hidden />, txt: local });
  return s;
}

interface Props {
  pausarFoto?: boolean;
  lot: Lot;
  aoAbrir: (id: number) => void;
  /** Lance que chegou pelo WebSocket, sobrepondo o do último fetch. */
  lanceAoVivo?: number;
  piscando?: boolean;
  destaque?: boolean;
  rodape?: ReactNode;
  favoritado?: boolean;
  /** Ausente = card sem favorito: usado em contextos sem sessão. */
  aoFavoritar?: (id: number) => void;
}

export function LotCard({
  lot, aoAbrir, lanceAoVivo, piscando, destaque, rodape, favoritado, aoFavoritar, pausarFoto = false,
}: Props) {
  const foto = lot.photos?.[0] ?? null;
  const lance = lanceAoVivo ?? lot.current_bid ?? lot.min_bid;
  const rotulo = rotuloLance(lot, lanceAoVivo);
  const fracao = fracaoDaAvaliacao(lot, lance);
  const fimMs = lot.closing_model === 'timer_por_lote' && lot.auction_end_utc ? Date.parse(lot.auction_end_utc) - Date.now() : null;
  const agora = useAgora(fimMs != null && fimMs > 0 && fimMs < 3_600_000);
  const when = whenLabel(lot, agora);
  const prazo = contagem(lot, agora) ?? when.text;
  const fonte = SRC_LABEL[lot.source_id] ?? lot.source_id;
  const abrir = useCallback(() => aoAbrir(lot.id), [aoAbrir, lot.id]);

  return (
    <article
      className={`card${piscando ? ' flash' : ''}${destaque ? ' hit-novo' : ''}`}
      data-id={lot.id}
      data-fim={lot.auction_end_utc ?? undefined}
    >
      <div className="lc-foto">
        {!pausarFoto && <img
          loading="lazy"
          className={foto ? '' : 'is-nopic'}
          src={foto ? img(foto, 640) : nopicDe(lot)}
          data-fallback={foto ? undefined : 'yes'}
          onError={aoFalharImagem}
          alt={foto ? `Foto do lote ${titulo(lot)}` : 'Lote sem foto disponível'}
        />}
        <div className="lc-selos">
          {lot.is_novo && <span className="lc-selo novo">Novo</span>}
          {lot.doc_type && (
            <span className={`lc-selo ${lot.doc_type}`}>{LABEL_DOC[lot.doc_type] ?? lot.doc_type}</span>
          )}
        </div>
        {aoFavoritar && (
          <button
            type="button"
            className="lc-fav"
            onClick={(e) => { e.stopPropagation(); aoFavoritar(lot.id); }}
            aria-pressed={favoritado}
            aria-label={favoritado ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
            title={favoritado ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
          >
            <span><Heart aria-hidden fill={favoritado ? 'currentColor' : 'none'} /></span>
          </button>
        )}
        <span className="lc-fonte"><i aria-hidden>{fonte.charAt(0)}</i>{fonte}</span>
        {lot.auctioneer_name && (
          <span className="lc-cred" title={`Foto publicada por ${lot.auctioneer_name}`}>foto: {lot.auctioneer_name}</span>
        )}
      </div>

      <div className="lc-corpo">
        <span className="lc-tipo">{tipoDe(lot)}</span>
        <h3 className="lc-titulo">
          <button
            type="button"
            className="lc-abrir"
            onClick={abrir}
            aria-label={`${titulo(lot)}. ${lance != null ? `${rotulo} ${money(lance)}` : 'sem lance publicado'}. ${prazo}`}
          >
            {titulo(lot)}
          </button>
        </h3>
        <ul className="lc-specs">
          {specsDe(lot).map((s) => (
            <li key={s.txt}>{s.ico}{s.txt}</li>
          ))}
        </ul>
        {fracao != null && (
          <div className="lc-pos" title={TITULO_AVALIACAO}>
            <div className="lc-trilho"><i style={{ width: `${fracao}%` }} /></div>
            <div className="lc-leg"><span>{fracao}% da avaliação</span><s className="mono">{money(lot.appraisal)}</s></div>
          </div>
        )}
        <div className="lc-preco">
          <div>
            {lance != null ? (
              <>
                <span className="lc-rot">{rotulo}</span>
                <span className="lc-v">{money(lance)}</span>
              </>
            ) : (
              <span className="lc-nada">Sem lance publicado</span>
            )}
          </div>
          <span className="lc-seta" aria-hidden><ArrowUpRight /></span>
        </div>
        {lot.bid_suspect && (
          <div className="lc-suspeito" title="Valor publicado pela fonte fora de faixa plausível">
            valor atípico na fonte
          </div>
        )}
        {rodape}
      </div>

      <div className={`lc-prazo ${when.cls || 'depois'}`}>
        <i aria-hidden />
        <span>{prazo}</span>
      </div>
    </article>
  );
}
