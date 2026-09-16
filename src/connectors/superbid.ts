import { fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const BASE = 'https://offer-query.superbid.net/offers/';
const HEADERS = { origin: 'https://www.superbid.net', referer: 'https://www.superbid.net/' };

/**
 * Três coisas que a API exige e que a versão anterior deste conector ignorava:
 *
 * 1. `searchType=opened` — sem ele vêm lotes encerrados desde 2022.
 * 2. `orderBy=id:asc` — SEM ORDENAÇÃO A PAGINAÇÃO NÃO É ESTÁVEL. Medido:
 *    pedir a mesma página duas vezes devolve conjuntos com 50% de interseção,
 *    e paginar 1..N colhia 5.822 registros com apenas 4.253 únicos, ou seja
 *    1.569 veículos (27%) nunca entravam no índice.
 * 3b. `portalId` aceita LISTA. Com só o portal 2 ficavam 148 lotes de fora, 146
 *     deles de um único leiloeiro (RMoysés), que publica no portal 15. Medido:
 *     imóvel foi de 1.489 para 1.581 ao incluir o 15.
 * 3. `filter=product.productType.id:[...]` — o filtro por categoria existe e é
 *    muito mais barato que enumerar por palavra-chave. O código antigo pedia
 *    `keyword=caminhao`, recebia 366 ofertas e descartava 364 porque exigia
 *    `productType.id === 10`; caminhão, ônibus e máquina ficavam fora por
 *    construção, justamente os tipos que o filtro do produto oferece.
 */

/** productType da fonte -> nosso par (tipo de bem, tipo de veículo). */
const PRODUCT_TYPES: Record<number, { asset: 'veiculo' | 'imovel' | 'outro'; hint: string }> = {
  10: { asset: 'veiculo', hint: 'carros e motos' },
  11: { asset: 'veiculo', hint: 'caminhao' },
  12: { asset: 'veiculo', hint: 'nautico' },
  13: { asset: 'imovel', hint: 'imovel' },
  15: { asset: 'veiculo', hint: 'maquina' },
};
const TIPOS_VEICULO = [10, 11, 12, 15];

/** A fonte devolve o estado por extenso; o índice guarda a sigla. */
const UF_POR_NOME: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};

function toUf(nome?: string | null): string | null {
  if (!nome) return null;
  const v = nome.trim();
  if (/^[A-Z]{2}$/.test(v)) return v;
  const chave = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return UF_POR_NOME[chave] ?? null;
}
function toUtc(brt?: string | null, epochMs?: number | null): Date | null {
  if (epochMs) return new Date(epochMs);
  if (!brt) return null;
  const d = new Date(brt.replace(' ', 'T') + '-03:00');
  return isNaN(d.getTime()) ? null : d;
}

function mapOffer(o: any): CanonicalLot | null {
  const product = o.product ?? {};
  const pt = PRODUCT_TYPES[product?.productType?.id];
  if (!pt) return null;
  const title = product.shortDesc ?? o.offerDescription ?? '';
  if (!title) return null;
  if (pt.asset === 'veiculo' && looksLikePart(title)) return null;

  const detail = o.offerDetail ?? {};
  // Parser de veículo NÃO roda em imóvel: "IMÓVEL RURAL EM MERCEDES-PR" virava
  // Mercedes-Benz e "Sobrado - City América" virava Honda City (10 em 1.000).
  const parsed =
    pt.asset === 'veiculo'
      ? parseTitle(title, product?.brand?.description, product?.model?.description)
      : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const photos: string[] = Array.isArray(product.galleryJson)
    ? product.galleryJson.map((g: any) => g.link).filter(Boolean).slice(0, 30)
    : [];
  const sellerName = o.seller?.name ?? o.store?.name ?? null;

  return {
    sourceId: 'superbid',
    externalId: String(o.id),
    lotUrl: `https://www.superbid.net/oferta/${o.id}`,
    titleRaw: title,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    km: null,
    docType: product?.subCategory?.description ?? null,
    sourceCategory: product?.subCategory?.description ?? product?.subCategory?.category?.description ?? pt.hint,
    sourceGroup: pt.hint,
    assetType: pt.asset,
    closingModel: 'timer_por_lote',
    auctionStartUtc: toUtc(o.auction?.beginDate),
    auctionEndUtc: toUtc(o.endDate, o.endDateTime),
    sourceTz: 'America/Sao_Paulo',
    status: o.statusId === 1 ? 'aberto' : o.offerStatus?.sold ? 'vendido' : 'encerrado',
    currentBid: o.hasBids ? Number(detail.currentMaxBid ?? o.price) : null,
    minBid: Number(detail.initialBidValue ?? detail.currentMinBid ?? o.price) || null,
    // currentBidIncrement vem como objeto {currentBidIncrement, ...Formatted},
    // não como número: gravar direto estourava o numeric do Postgres.
    bidIncrement:
      typeof o.currentBidIncrement === 'object' && o.currentBidIncrement
        ? Number(o.currentBidIncrement.currentBidIncrement) || null
        : Number(o.currentBidIncrement) || null,
    appraisal: Number(detail.releaseValue) || null,
    feesPct: Number(o.commercialCondition?.auctioneerCommissionPercent) || null,
    auctioneerName: o.auction?.auctioneer ?? null,
    auctioneerReg: null,
    sellerName,
    sellerType: classifySeller(sellerName) as any,
    // A fonte já manda "Campo Grande - MS" no campo city; sem tirar o sufixo
    // a interface mostrava "Campo Grande - MS/MS".
    city: (product?.location?.city ?? o.seller?.city ?? null)?.replace(/\s*-\s*[A-Z]{2}$/, '') ?? null,
    state: toUf(product?.location?.state),
    lat: product?.location?.locationGeo?.lat ?? null,
    lon: product?.location?.locationGeo?.lon ?? null,
    photos,
    financeable: o.commercialCondition?.maxInstallments ? true : null,
    raw: { grupoFonte: pt.hint, lotNumber: o.lotNumber, store: o.store?.name, totalBids: o.totalBids, visits: o.visits },
  };
}

export const superbid: Connector = {
  def: {
    id: 'superbid',
    name: 'Superbid',
    platform: 'Superbid Exchange',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.superbid.net',
    notes: 'API aberta offer-query; exige searchType=opened e Origin. Teto de 10 mil por consulta.',
  },
  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const pageSize = 500;

    // Uma fatia por productType: cada uma cabe folgada na janela de 10.000
    // do índice, e assim nenhuma categoria fica de fora por construção.
    const querIm = !assetTypes || assetTypes.includes('imovel');
    const querVe = !assetTypes || assetTypes.includes('veiculo');
    const tipos = [...(querVe ? TIPOS_VEICULO : []), ...(querIm ? [13] : [])];

    // Cota POR TIPO, não global: com limite único, o tipo 10 (5.819 carros e
    // motos) consumia a cota inteira e caminhão, ônibus e máquina nunca eram
    // alcançados — as categorias que o filtro existe justamente para trazer.
    const cota = Math.max(pageSize, Math.ceil(limit / Math.max(1, tipos.length)));

    for (const tipo of tipos) {
      const antes = lots.length;
      for (let page = 1; lots.length - antes < cota && lots.length < limit; page++) {
        const url =
          `${BASE}?portalId=[2,15]&searchType=opened&orderBy=id:asc&pageSize=${pageSize}&pageNumber=${page}` +
          `&locale=pt_BR&filter=${encodeURIComponent(`product.productType.id:${tipo};`)}`;
        const { status: st, data } = await fetchJson<any>(url, { headers: HEADERS, gapMs: 1200 });
        status = st;
        const offers: any[] = data?.offers ?? [];
        if (!offers.length) break;
        fetched += offers.length;
        for (const o of offers) {
          const mapped = mapOffer(o);
          if (mapped) lots.push(mapped);
          else skipped++;
        }
        if (offers.length < pageSize) break;
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
