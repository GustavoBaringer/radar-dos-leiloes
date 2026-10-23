import { comNavegador, getJsonViaNavegador } from './navegador.js';
import type { Connector, CollectResult, CollectOptions } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart, classifyAsset } from '../core/normalize.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

const BASE = 'https://offer-query.superbid.net/offers/';
const HEADERS = { origin: 'https://www.superbid.net', referer: 'https://www.superbid.net/' };
/** Passa pelo Cloudflare com navegação normal; a API em si já é cross-origin
 * dentro da mesma sessão (cookie __cf_bm é `Domain=superbid.net`, vale pro
 * subdomínio offer-query também — testado). */
const ENTRADA = 'https://www.superbid.net/';

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

export function mapOffer(o: any, host?: string, expectedStoreId?: number): CanonicalLot | null {
  if (expectedStoreId !== undefined) {
    const storeMatch =
      o?.store?.id === expectedStoreId ||
      (Array.isArray(o?.stores) && o.stores.some((s: any) => s?.id === expectedStoreId));
    if (!storeMatch) return null;
  }

  const product = o.product ?? {};
  const pt = PRODUCT_TYPES[product?.productType?.id];
  const title = product.shortDesc ?? o.offerDescription ?? '';
  if (!pt || !title) return null;
  // QUEM CLASSIFICA É A SUBCATEGORIA, não o productType. O productType é largo
  // e a fonte o preenche torto: 229 lotes com subCategory "Terrenos Urbanos",
  // "Apartamentos" ou "Casas" foram gravados como `veiculo` só porque o
  // productType era de veículos — era o que fazia a busca de "marea" no filtro
  // de veículos devolver 21 imóveis (medido em 05/10/2026).
  // A subCategoria erra no sentido inverso também ("VEICULO CAMINHONETE I/KIA
  // UK2500 HD SC" sob imóveis, 03/10) e quem concilia é o classifyAsset: ele
  // só troca a categoria por imóvel/fazenda quando o título NÃO declara
  // veículo. Melhor um alarme de veículo do que perder o bem num terreno.
  const subCategoria =
    product?.subCategory?.description ?? product?.subCategory?.category?.description ?? null;
  const cls = classifyAsset(title, subCategoria ?? pt.hint, null);
  const asset: 'imovel' | 'veiculo' | 'outro' = subCategoria ? cls.assetType : pt.asset;
  if (asset === 'veiculo' && looksLikePart(title)) return null;

  const detail = o.offerDetail ?? {};
  // Parser de veículo NÃO roda em imóvel: "IMÓVEL RURAL EM MERCEDES-PR" virava
  // Mercedes-Benz e "Sobrado - City América" virava Honda City (10 em 1.000).
  const parsed =
    asset === 'veiculo'
      ? parseTitle(title, product?.brand?.description, product?.model?.description)
      : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const photos: string[] = Array.isArray(product.galleryJson)
    ? product.galleryJson.map((g: any) => g.link).filter(Boolean).slice(0, 30)
    : [];
  const sellerName = o.seller?.name ?? o.store?.name ?? null;

  return {
    sourceId: 'superbid',
    externalId: String(o.id),
    lotUrl: host ? `https://${host}/oferta/${o.id}` : `https://www.superbid.net/oferta/${o.id}`,
    titleRaw: title,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    km: null,
    docType: product?.subCategory?.description ?? null,
    sourceCategory: subCategoria ?? pt.hint,
    sourceGroup: pt.hint,
    assetType: asset,
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
    auctioneerReg: o.auction?.registry ?? null,
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

export interface SuperbidTenantConfig {
  storeId: number;
  host: string;
  name: string;
}

export const SUPERBID_TENANTS: Record<string, SuperbidTenantConfig> = {
  'mgrleiloes.com.br': {
    storeId: 16061,
    host: 'www.mgrleiloes.com.br',
    name: 'MGR Leilões',
  },
};

export function resolveSuperbidTenant(tenant: string): SuperbidTenantConfig {
  const norm = tenant.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').trim();
  const config = SUPERBID_TENANTS[norm];
  if (!config) {
    throw new Error(`single-tenant '${tenant}' não mapeado para storeId de Superbid`);
  }
  return config;
}

export async function collectSuperbid(
  { limit, assetTypes, tenant, observer }: CollectOptions,
  io: {
    comNavegador: typeof comNavegador;
    getJsonViaNavegador: typeof getJsonViaNavegador;
  } = { comNavegador, getJsonViaNavegador },
): Promise<CollectResult> {
  if (tenant) {
    const config = resolveSuperbidTenant(tenant);
    const attempt = await observer?.start(tenant.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''));
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const pageSize = 50;
    let truncated = false;
    const notes: string[] = [];
    const seenIds = new Set<string>();

    try {
      await io.comNavegador(`https://${config.host}`, async (page) => {
        let totalObservado: number | null = null;
        for (let pagina = 1; lots.length < limit; pagina++) {
          throwIfCancelled();
          const queryFilter = encodeURIComponent(`stores.id:${config.storeId}`);
          const url =
            `${BASE}?filter=${queryFilter}&locale=pt_BR&orderBy=endDate:asc&pageNumber=${pagina}&pageSize=${pageSize}` +
            `&portalId=[2,15]&preOrderBy=orderByFirstOpenedOffers&requestOrigin=store&searchType=opened&timeZoneId=America%2FSao_Paulo`;
          const { status: st, data } = await io.getJsonViaNavegador<any>(page, url, {
            origin: `https://${config.host}`,
            referer: `https://${config.host}/`,
          });
          throwIfCancelled();
          status = st;
          attempt?.response(st);
          if (st !== 200) {
            attempt?.failure('network');
            truncated = true;
            notes.push(`HTTP ${st} na página ${pagina}`);
            break;
          }
          if (!data || !Array.isArray(data.offers)) {
            attempt?.failure('parser');
            truncated = true;
            notes.push(`schema inválido: resposta sem offers array`);
            break;
          }
          if (typeof data.total === 'number') {
            totalObservado = data.total;
          }
          const offers: any[] = data.offers;
          if (!offers.length) break;
          fetched += offers.length;

          let newIdsOnPage = 0;
          for (const o of offers) {
            throwIfCancelled();
            const idStr = String(o.id);
            if (seenIds.has(idStr)) continue;
            seenIds.add(idStr);
            newIdsOnPage++;

            const mapped = mapOffer(o, config.host, config.storeId);
            if (mapped && (!assetTypes || assetTypes.includes(mapped.assetType as string))) {
              lots.push(mapped);
              if (lots.length >= limit) {
                truncated = true;
                notes.push(`limite de ${limit} lotes atingido`);
                break;
              }
            } else {
              skipped++;
            }
          }

          // Parada fail-closed se API repetir ofertas de páginas anteriores
          if (offers.length > 0 && newIdsOnPage === 0) {
            attempt?.failure('parser');
            truncated = true;
            notes.push(`API repetiu ofertas na página ${pagina}; parada fail-closed`);
            break;
          }

          if (truncated || offers.length < pageSize) break;
          if (totalObservado !== null && seenIds.size >= totalObservado) break;
        }

        if (totalObservado !== null && lots.length < limit && seenIds.size < totalObservado && !truncated) {
          truncated = true;
          notes.push(`coletados ${seenIds.size} de ${totalObservado} observados`);
        }
      });
    } catch (error) {
      if (error instanceof CollectionCancellationError) {
        attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
        notes.push(`cancelamento por ${error.kind}`);
      } else {
        attempt?.failure('network');
        notes.push(`falha: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      await attempt?.finish({ fetched, skipped, returned: lots.length, truncated: truncated || lots.length >= limit });
    }

    const note = notes.length ? notes.join('; ') : undefined;
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status, ...(note ? { note } : {}) };
  }

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

  await io.comNavegador(ENTRADA, async (page) => {
    for (const tipo of tipos) {
      const antes = lots.length;
      for (let pagina = 1; lots.length - antes < cota && lots.length < limit; pagina++) {
        const url =
          `${BASE}?portalId=[2,15]&searchType=opened&orderBy=id:asc&pageSize=${pageSize}&pageNumber=${pagina}` +
          `&locale=pt_BR&filter=${encodeURIComponent(`product.productType.id:${tipo};`)}`;
        const { status: st, data } = await io.getJsonViaNavegador<any>(page, url, HEADERS);
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
  });
  return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
}

export const superbid: Connector = {
  def: {
    id: 'superbid',
    name: 'Superbid',
    platform: 'Superbid Exchange',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.superbid.net',
    notes: 'API offer-query; exige searchType=opened e Origin. Teto de 10 mil por consulta. Via Chromium headless desde 22/09 (Cloudflare bloqueia fetch cru). Suporte tenant para MGR Leilões (storeId 16061).',
  },
  async collect(opts: CollectOptions): Promise<CollectResult> {
    return collectSuperbid(opts);
  },
};
