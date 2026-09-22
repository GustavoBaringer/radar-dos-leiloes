/**
 * O contrato que o servidor entrega. Escrito à mão a partir do SELECT de
 * `searchLots` em src/core/repo.ts — não é inferido, então divergência aparece
 * no typecheck e não numa tela vazia.
 */
export type ClosingModel = 'timer_por_lote' | 'pregao_em_horario' | 'sequencial';
export type LotStatus = 'agendado' | 'aberto' | 'encerrado' | 'vendido' | 'sem_data';
export type AssetType = 'veiculo' | 'imovel' | 'outro';
export type Sort = 'ending_soon' | 'discount' | 'price_asc' | 'price_desc' | 'recent';

export interface Lot {
  id: number;
  source_id: string;
  external_id: string;
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
  closing_model: ClosingModel;
  auction_start_utc: string | null;
  auction_end_utc: string | null;
  source_tz: string | null;
  status: LotStatus;
  current_bid: number | null;
  min_bid: number | null;
  bid_increment: number | null;
  appraisal: number | null;
  fees_pct: number | null;
  bid_suspect: boolean;
  asset_type: AssetType;
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
  collected_at: string;
  first_seen_at: string;
  is_novo: boolean;
  effective_status: LotStatus;
  discount_pct: number | null;
  /** Só no detalhe (/api/lot/:id). */
  color?: string | null;
  fuel?: string | null;
  plate_masked?: string | null;
  bid_history?: Array<{ bid: number; observed_at: string }>;
}

/** Item de faceta. `label` só vem em cidade, que agrupa por chave sem acento. */
export interface FacetRow {
  value: string;
  count: number;
  label?: string;
}

export interface Facets {
  states: FacetRow[];
  cities: FacetRow[];
  sources: FacetRow[];
  sellerTypes: FacetRow[];
  assetTypes: FacetRow[];
  vehicleTypes: FacetRow[];
  propertyTypes: FacetRow[];
  auctioneers: FacetRow[];
  sellers: FacetRow[];
  statuses: FacetRow[];
}

export interface SearchResponse {
  total: number;
  page: number;
  pageSize: number;
  interpreted: { brand: string | null; model: string | null; freeTerms: string[] };
  items: Lot[];
  facets: Facets;
}

export interface Alerta {
  id: number;
  label: string;
  q: string | null;
  channels: string[];
  email: string | null;
  total: number;
}

export type Hit = Lot & { seen: boolean; hit_em: string; labels: string[] };

export type Favorito = Lot & { favorited_em: string };

export interface Stats {
  totals: {
    lots: number; abertos: number; agendados: number; sem_data: number;
    com_fim: number; com_km: number; com_lance: number; marcas: number;
    veiculos: number; imoveis: number; outros: number;
  };
  bySource: Array<{
    source_id: string; name: string; lots: number; com_fim: number;
    com_lance: number; com_km: number; ultima_coleta: string | null;
  }>;
  runs: Array<{
    source_id: string; job: string; started_at: string; ok: boolean | null;
    error: string | null; http_status: number | null;
    fetched: number; upserted: number; skipped: number;
  }>;
}

/** Mensagens do /ws. O servidor filtra por papel; o cliente re-checa. */
export type WsMessage =
  | { type: 'bids'; changes: Array<{ lotId: number; newBid: number; title: string }> }
  | { type: 'collect'; sourceId: string; upserted: number }
  | { type: 'encerrados'; total: number; porPrazo?: number; porAusencia?: number; origem?: string }
  | { type: 'alertas'; disparos: Array<{ label: string; title: string }> };

export interface PontoMapa {
  k: string;
  lat: number;
  lon: number;
  cidade: string | null;
  uf: string | null;
  camada: 'patio' | 'cidade';
  n: number;
}

export interface RespostaMapa {
  pontos: PontoMapa[];
  total: number;
  semLocalizacao: number;
  soCidade: number;
  semNada: number;
}
