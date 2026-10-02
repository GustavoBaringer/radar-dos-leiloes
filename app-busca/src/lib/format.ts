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

/**
 * Lote de pregão que ainda não começou publica o lance de ABERTURA. Chamar isso
 * de "lance atual" fazia um Honda de R$ 350 parecer arrematável por esse valor.
 * O detalhe (/api/lot) não traz `effective_status`, daí o recuo para `status`.
 */
export function rotuloLance(
  lot: Pick<Lot, 'current_bid' | 'status'> & { effective_status?: Lot['effective_status'] },
  aoVivo?: number,
): string {
  if (aoVivo != null) return 'Lance atual';
  if (lot.current_bid != null) return (lot.effective_status ?? lot.status) === 'agendado' ? 'Lance inicial' : 'Lance atual';
  return 'Lance mínimo';
}

/** Quanto o lance representa da avaliação, só quando a comparação é honesta. */
export function fracaoDaAvaliacao(lot: Pick<Lot, 'appraisal' | 'bid_suspect'>, lance: number | null | undefined): number | null {
  if (lot.bid_suspect || !lot.appraisal || lance == null || !(lot.appraisal > lance)) return null;
  return Math.max(1, Math.round((lance / lot.appraisal) * 100));
}

/** Na última hora de um timer, minuto e segundo: "Encerra em 38 min" para de mudar à vista. */
export function contagem(lot: Pick<Lot, 'closing_model' | 'auction_end_utc'>, agora: number): string | null {
  if (lot.closing_model !== 'timer_por_lote' || !lot.auction_end_utc) return null;
  const d = Date.parse(lot.auction_end_utc) - agora;
  if (d <= 0 || d >= 3_600_000) return null;
  const m = Math.floor(d / 60_000);
  const s = Math.floor((d % 60_000) / 1000);
  return `Encerra em ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
