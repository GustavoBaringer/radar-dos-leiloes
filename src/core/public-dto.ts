import { vendedorPublico } from './normalize.js';

export interface PublicBidHistoryItem { bid: number; observed_at: string }

/** Explicit public allowlist shared by list cards and the lot detail. */
export interface PublicLot {
  id: number;
  source_id: string;
  lot_url: string | null;
  title_raw: string;
  title_display: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  year_make: number | null;
  year_model: number | null;
  km: number | null;
  doc_type: string | null;
  closing_model: string;
  auction_start_utc: string | null;
  auction_end_utc: string | null;
  source_tz: string | null;
  status: string;
  current_bid: number | null;
  min_bid: number | null;
  bid_increment: number | null;
  appraisal: number | null;
  fees_pct: number | null;
  bid_suspect: boolean;
  asset_type: string;
  vehicle_type: string | null;
  property_type: string | null;
  source_category: string | null;
  auctioneer_name: string | null;
  auctioneer_reg: string | null;
  area: number | null;
  rooms: number | null;
  seller_name: string | null;
  seller_type: string | null;
  yard: string | null;
  city: string | null;
  state: string | null;
  photos: string[];
  photo_count: number;
  financeable: boolean | null;
  has_report: boolean | null;
  collected_at: string | null;
  first_seen_at: string | null;
  is_novo: boolean;
  effective_status: string;
  discount_pct: number | null;
  favorited?: boolean;
  color?: string | null;
  fuel?: string | null;
  plate_masked?: string | null;
  bid_history?: PublicBidHistoryItem[];
}

export interface PublicHit extends PublicLot {
  seen: boolean;
  hit_em: string | null;
  labels: string[];
}

export interface PublicFavorite extends PublicLot { favorited_em: string | null }

export interface PublicAlert {
  id: number;
  label: string;
  q: string | null;
  channels: string[];
  email: string | null;
  total: number;
  nao_vistos: number;
}

type Row = Record<string, unknown>;

function rowOf(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Registro de lote inválido.');
  return value as Row;
}

const text = (v: unknown): string | null => typeof v === 'string' ? v : null;
const number = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const bool = (v: unknown): boolean => v === true;
const date = (v: unknown): string | null => v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : text(v);

function safeHttpUrl(value: unknown, maxLength = Number.POSITIVE_INFINITY): string | null {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function photosOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const photos: string[] = [];
  for (const item of value.slice(0, 30)) {
    const url = safeHttpUrl(item, 4096);
    if (url) photos.push(url);
  }
  return photos;
}

function lotFields(source: Row, includeDetail: boolean): PublicLot {
  const id = number(source.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) throw new TypeError('Identificador de lote inválido.');
  const photos = photosOf(source.photos);
  const lot: PublicLot = {
    id,
    source_id: text(source.source_id) ?? '',
    lot_url: safeHttpUrl(source.lot_url),
    title_raw: text(source.title_raw) ?? '',
    title_display: text(source.title_display),
    brand: text(source.brand), model: text(source.model), version: text(source.version),
    year_make: number(source.year_make), year_model: number(source.year_model), km: number(source.km),
    doc_type: text(source.doc_type), closing_model: text(source.closing_model) ?? '',
    auction_start_utc: date(source.auction_start_utc), auction_end_utc: date(source.auction_end_utc),
    source_tz: text(source.source_tz), status: text(source.status) ?? '',
    current_bid: number(source.current_bid), min_bid: number(source.min_bid), bid_increment: number(source.bid_increment),
    appraisal: number(source.appraisal), fees_pct: number(source.fees_pct), bid_suspect: bool(source.bid_suspect),
    asset_type: text(source.asset_type) ?? '', vehicle_type: text(source.vehicle_type), property_type: text(source.property_type),
    source_category: text(source.source_category), auctioneer_name: text(source.auctioneer_name),
    auctioneer_reg: text(source.auctioneer_reg), area: number(source.area), rooms: number(source.rooms),
    seller_name: vendedorPublico(text(source.seller_name)), seller_type: text(source.seller_type),
    yard: text(source.yard), city: text(source.city), state: text(source.state), photos,
    photo_count: number(source.photo_count) ?? photos.length,
    financeable: typeof source.financeable === 'boolean' ? source.financeable : null,
    has_report: typeof source.has_report === 'boolean' ? source.has_report : null,
    collected_at: date(source.collected_at), first_seen_at: date(source.first_seen_at),
    is_novo: bool(source.is_novo), effective_status: text(source.effective_status) ?? text(source.status) ?? '',
    discount_pct: number(source.discount_pct),
  };
  if (typeof source.favorited === 'boolean') lot.favorited = source.favorited;
  if (includeDetail) {
    lot.color = text(source.color);
    lot.fuel = text(source.fuel);
    lot.plate_masked = text(source.plate_masked);
    if (Array.isArray(source.bid_history)) {
      lot.bid_history = source.bid_history.slice(0, 30).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const history = item as Row;
        const bid = number(history.bid), observedAt = date(history.observed_at);
        return bid === null || observedAt === null ? [] : [{ bid, observed_at: observedAt }];
      });
    }
  }
  return lot;
}

/** Public card projection. Unknown and internal row properties are never copied. */
export function toPublicLot(value: unknown): PublicLot {
  return lotFields(rowOf(value), true);
}

/** Public alert-hit serializer: only Lot fields and documented hit metadata. */
export function toPublicHit(value: unknown): PublicHit {
  const source = rowOf(value);
  const labels = Array.isArray(source.labels) ? source.labels.filter((v): v is string => typeof v === 'string').slice(0, 50) : [];
  return {
    ...lotFields(source, false),
    seen: bool(source.seen),
    hit_em: date(source.hit_em),
    labels,
  };
}

/** Public favorite serializer: only Lot fields and the favorite timestamp. */
export function toPublicFavorite(value: unknown): PublicFavorite {
  const source = rowOf(value);
  return { ...lotFields(source, false), favorited_em: date(source.favorited_em) };
}

/** Alert list allowlist, kept separate from the database alert row. */
export function toPublicAlert(value: unknown): PublicAlert {
  const source = rowOf(value);
  const channels = Array.isArray(source.channels)
    ? [...new Set(source.channels.filter((v): v is string => typeof v === 'string' && ['sino', 'push', 'email'].includes(v)))].slice(0, 3)
    : [];
  const id = number(source.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) throw new TypeError('Identificador de alerta inválido.');
  return {
    id,
    label: text(source.label) ?? '',
    q: text(source.q),
    channels,
    email: text(source.email),
    total: number(source.total) ?? 0,
    nao_vistos: number(source.nao_vistos) ?? 0,
  };
}
