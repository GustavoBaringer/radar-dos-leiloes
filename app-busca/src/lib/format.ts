import type { Lot } from './types';

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('pt-BR');

export const money = (v: number | null | undefined) => (v == null ? null : BRL.format(v));
export const numero = (v: number | null | undefined) => (v == null ? '—' : NUM.format(v));

export const dataBr = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;

export const dataCurta = (v: string) =>
  new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Foto servida pela nossa origem: o navegador recusa a do Kuss (ORB). */
export const img = (url: string, w?: number) =>
  `/api/img?u=${encodeURIComponent(url)}${w ? `&w=${w}` : ''}`;

export const NOPIC = '/nopic.svg';
export const NOPIC_IMOVEL = '/nopic-imovel.svg';
/** Silhueta de carro num anúncio de imóvel lê mal: o placeholder segue o bem. */
export const nopicDe = (lot: Pick<Lot, 'asset_type'>) =>
  lot.asset_type === 'imovel' ? NOPIC_IMOVEL : NOPIC;

export type Urgencia = '' | 'soon' | 'hot' | 'nodate';

/**
 * O rótulo de tempo muda conforme o MODELO de encerramento da fonte.
 *
 * Pregão ao vivo não tem fim por lote: mostrar contagem regressiva ali seria
 * mentira. Só `timer_por_lote` com fim publicado vira contagem; o resto vira a
 * data de abertura, e a ausência de data é dita com todas as letras.
 */
export function whenLabel(lot: Pick<Lot, 'closing_model' | 'auction_end_utc' | 'auction_start_utc'>, agora = Date.now()): {
  text: string;
  cls: Urgencia;
} {
  if (lot.closing_model === 'timer_por_lote' && lot.auction_end_utc) {
    const diff = new Date(lot.auction_end_utc).getTime() - agora;
    if (diff <= 0) return { text: 'Encerrado', cls: 'nodate' };
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const d = Math.floor(h / 24);
    if (d >= 1) return { text: `Encerra em ${d}d ${h % 24}h`, cls: '' };
    if (h >= 1) return { text: `Encerra em ${h}h ${m}min`, cls: 'soon' };
    return { text: `Encerra em ${m} min`, cls: 'hot' };
  }
  if (lot.auction_start_utc) {
    const start = new Date(lot.auction_start_utc);
    const label = start.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const prefix = lot.closing_model === 'sequencial' ? 'Pregão sequencial' : 'Pregão';
    return { text: `${prefix} em ${label}`, cls: start.getTime() - agora < 86_400_000 ? 'soon' : '' };
  }
  return { text: 'Sem data de leilão definida', cls: 'nodate' };
}

/** O título da fonte continua guardado; o de exibição é o padronizado. */
export const titulo = (lot: Pick<Lot, 'title_display' | 'title_raw'>) => lot.title_display || lot.title_raw;

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
