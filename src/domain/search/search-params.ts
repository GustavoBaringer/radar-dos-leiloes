/** Todo filtro de lista aceita string única, CSV ou array — a tela manda CSV. */
type Multi = string | string[] | undefined;

export interface SearchParams {
  q?: string;
  uf?: Multi;
  status?: Multi;
  sellerType?: Multi;
  sourceId?: Multi;
  /** Domínio real do site que publicou o lote, não o id do conector. */
  sourceSite?: Multi;
  /** Nome do leiloeiro como a fonte publica; só ~57% dos lotes trazem. */
  auctioneer?: Multi;
  seller?: Multi;
  /** Único de propósito: veículo e imóvel têm filtros e rótulos diferentes. */
  assetType?: string;
  vehicleType?: Multi;
  propertyType?: Multi;
  /** Chave de cidade (sem acento, maiúscula) — só vale com UF escolhida. */
  city?: Multi;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  onlyWithDate?: boolean;
  onlyWithPhoto?: boolean;
  /** Situação do bem (sinistrado, conservado, judicial...), como `campos.docType()` grava. */
  docType?: Multi;
  /** Prazo pela mesma data que vence o lote: fim do timer, ou início do pregão. */
  endsWithin?: 'hoje' | '7d';
  /** Lance abaixo da avaliação publicada, sem contar valor marcado como atípico. */
  belowAppraisal?: boolean;
  /** Ponto do mapa: 'lat,lon' ou 'c:CHAVECIDADE/UF'. */
  place?: string;
  /** Por padrão a busca esconde lote encerrado; a tela de cobertura pede o contrário. */
  includeEnded?: boolean;
  sort?: 'ending_soon' | 'price_asc' | 'price_desc' | 'recent' | 'discount';
  page?: number;
  pageSize?: number;
}
