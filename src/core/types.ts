export type ClosingModel = 'timer_por_lote' | 'pregao_em_horario' | 'sequencial';
export type LotStatus = 'agendado' | 'aberto' | 'encerrado' | 'vendido' | 'sem_data';
export type AssetType = 'veiculo' | 'imovel' | 'outro';
export type PropertyType =
  | 'apartamento'
  | 'casa'
  | 'terreno'
  | 'comercial'
  | 'rural'
  | 'vaga'
  | 'outro';
export type VehicleType =
  | 'carro' | 'suv' | 'picape' | 'moto' | 'caminhao' | 'onibus'
  | 'utilitario' | 'maquina' | 'reboque' | 'nautico' | 'peca' | 'outro';
export type SellerType = 'banco' | 'seguradora' | 'financeira' | 'locadora' | 'judicial' | 'orgao' | 'particular' | 'desconhecido';

export interface CanonicalLot {
  sourceId: string;
  externalId: string;
  lotUrl?: string | null;
  titleRaw: string;

  brand?: string | null;
  model?: string | null;
  version?: string | null;
  yearMake?: number | null;
  yearModel?: number | null;
  km?: number | null;
  color?: string | null;
  fuel?: string | null;
  plateMasked?: string | null;

  docType?: string | null;
  /** Como a FONTE classifica o lote (ex.: "Automóveis", "Hatches", "Carros"). */
  sourceCategory?: string | null;
  /** Categoria de nível acima da fonte, quando existir (grupo do produto). */
  sourceGroup?: string | null;
  assetType?: AssetType | null;
  vehicleType?: VehicleType | null;
  propertyType?: PropertyType | null;
  closingModel: ClosingModel;
  auctionStartUtc?: Date | null;
  auctionEndUtc?: Date | null;
  sourceTz: string;
  status: LotStatus;

  currentBid?: number | null;
  minBid?: number | null;
  bidIncrement?: number | null;
  appraisal?: number | null;
  feesPct?: number | null;
  feesAmount?: number | null;

  auctioneerName?: string | null;
  auctioneerReg?: string | null;
  sellerName?: string | null;
  sellerType?: SellerType | null;

  yard?: string | null;
  city?: string | null;
  state?: string | null;
  lat?: number | null;
  lon?: number | null;

  photos: string[];
  financeable?: boolean | null;
  hasReport?: boolean | null;
  raw?: unknown;
}

export interface SourceDef {
  id: string;
  name: string;
  platform?: string;
  method: 'api' | 'html' | 'json-embedded';
  tier: number;
  siteUrl: string;
  notes?: string;
}
