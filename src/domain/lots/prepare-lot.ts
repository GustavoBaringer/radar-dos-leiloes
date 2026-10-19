import type { AssetType, CanonicalLot, PropertyType, VehicleType } from './types.js';
import * as campos from './campos.js';
import {
  buildSearchText,
  chaveCidade,
  classifyAsset,
  classifyProperty,
  completaVeiculo,
  looksLikeCollectible,
  marcaCanonica,
  scrubPlates,
  tituloDeVeiculoLimpo,
  tipoForteDoTitulo,
} from './normalize.js';
import { isBidSuspect } from './bid-rules.js';

export interface PreparedLotFields {
  city: string | null;
  state: string | null;
  color: string | null;
  fuel: string | null;
  docType: string | null;
  yearMake: number | null;
  yearModel: number | null;
  km: number | null;
  currentBid: number | null;
  minBid: number | null;
  bidIncrement: number | null;
  appraisal: number | null;
  lotUrl: string | null;
  yard: string | null;
  sellerName: string | null;
  auctioneerName: string | null;
  feesPct: number | null;
  photos: string[];
}

export interface PreparedLot {
  canonicalLot: CanonicalLot;
  titleRaw: string;
  plateMasked: string | null;
  bidSuspect: boolean;
  assetType: AssetType;
  vehicleType: VehicleType | null;
  propertyType: PropertyType | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  searchText: string;
  titleDisplay: string;
  sourceCategory: string | null;
  cityKey: string | null;
  fields: PreparedLotFields;
}

export type PrepareLotResult =
  | { kind: 'out-of-scope'; sourceId: string; externalId: string }
  | { kind: 'accepted'; lot: PreparedLot };

/** Pure normalization and scope policy run before a CanonicalLot is persisted. */
export function prepareLotForPersistence(l: CanonicalLot): PrepareLotResult {
  const scrubbed = scrubPlates(l.titleRaw);
  const titleRaw = scrubbed.text;
  const plateMasked = l.plateMasked ?? scrubbed.plateMasked;
  const versionFonte = l.version ? scrubPlates(l.version).text : null;
  const bidSuspect = isBidSuspect(
    campos.dinheiro(l.currentBid) ?? campos.dinheiro(l.minBid),
    campos.dinheiro(l.appraisal),
  );
  const raw = l.raw as Record<string, unknown> | null | undefined;
  const textoEscopo = [titleRaw, l.sourceCategory, raw?.descricao, raw?.description, raw?.leilao, raw?.categoria]
    .filter(Boolean)
    .join(' ');
  const collectible = looksLikeCollectible(textoEscopo);
  const cls = classifyAsset(titleRaw, l.sourceCategory, l.sourceGroup);
  const assetType: AssetType = collectible ? 'outro' : (l.assetType ?? cls.assetType);
  if (assetType === 'outro') {
    return { kind: 'out-of-scope', sourceId: l.sourceId, externalId: l.externalId };
  }

  const forte = tipoForteDoTitulo(titleRaw, l.sourceCategory);
  const vehicleType = assetType === 'veiculo' ? (forte ?? l.vehicleType ?? cls.vehicleType) : null;
  const propertyType = assetType === 'imovel' ? (l.propertyType ?? classifyProperty(titleRaw, l.sourceCategory)) : null;
  const brand = marcaCanonica(l.brand, titleRaw, vehicleType);
  const modeloFonte = (l.model ?? '').trim() || null;
  const extra = modeloFonte ? null : completaVeiculo(titleRaw, brand, vehicleType);
  const model = modeloFonte ?? extra?.model ?? null;
  const version = modeloFonte ? versionFonte : (versionFonte || extra?.version || null);
  const searchText = buildSearchText([titleRaw, brand, model, version, l.city, l.state, l.sellerName]);
  const fields: PreparedLotFields = {
    city: campos.caixaDeTitulo(l.city),
    state: campos.uf(l.state),
    color: campos.cor(l.color),
    fuel: campos.combustivel(l.fuel),
    docType: campos.docType(l.docType),
    yearMake: campos.ano(l.yearMake) ?? campos.ano(extra?.yearMake),
    yearModel: campos.ano(l.yearModel) ?? campos.ano(extra?.yearModel),
    km: campos.km(l.km),
    currentBid: campos.dinheiro(l.currentBid),
    minBid: campos.dinheiro(l.minBid),
    bidIncrement: campos.dinheiro(l.bidIncrement),
    appraisal: campos.dinheiro(l.appraisal),
    lotUrl: campos.url(l.lotUrl),
    yard: campos.texto(l.yard),
    sellerName: campos.texto(l.sellerName),
    auctioneerName: campos.texto(l.auctioneerName),
    feesPct: campos.porcentagem(l.feesPct),
    photos: campos.fotos(l.photos),
  };
  const sourceCategory = campos.texto(l.sourceCategory) ?? (l.docType && !fields.docType ? campos.texto(l.docType) : null);
  const area = Number(raw?.areaPrivativa ?? raw?.areaTotal ?? raw?.areaTerreno ?? NaN);
  const titleDisplay = assetType === 'imovel'
    ? campos.tituloImovel({
        propertyType,
        area: Number.isFinite(area) ? area : null,
        city: fields.city,
        state: fields.state,
        neighborhood: campos.bairroDoTitulo(titleRaw, fields.city),
        titleRaw,
      })
    : campos.tituloVeiculo({
        brand,
        model,
        version,
        yearMake: fields.yearMake,
        yearModel: fields.yearModel,
        titleRaw: assetType === 'veiculo' ? tituloDeVeiculoLimpo(titleRaw) : titleRaw,
      });

  return {
    kind: 'accepted',
    lot: {
      canonicalLot: l,
      titleRaw,
      plateMasked,
      bidSuspect,
      assetType,
      vehicleType,
      propertyType,
      brand,
      model,
      version,
      searchText,
      titleDisplay,
      sourceCategory,
      cityKey: chaveCidade(fields.city),
      fields,
    },
  };
}
