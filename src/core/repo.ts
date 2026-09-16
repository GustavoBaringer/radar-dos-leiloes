import { query, pool } from './db.js';
import { buildSearchText, parseQuery, scrubPlates, classifyAsset, classifyProperty, chaveCidade } from './normalize.js';
import { VENCIDO } from './encerramento.js';
import * as campos from './campos.js';
import type { CanonicalLot } from './types.js';
import { connectors } from '../connectors/index.js';

export async function ensureSources() {
  for (const c of connectors) {
    await query(
      `INSERT INTO sources (id, name, platform, method, tier, site_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, platform=EXCLUDED.platform,
         method=EXCLUDED.method, tier=EXCLUDED.tier, site_url=EXCLUDED.site_url, notes=EXCLUDED.notes`,
      [c.def.id, c.def.name, c.def.platform ?? null, c.def.method, c.def.tier, c.def.siteUrl, c.def.notes ?? null],
    );
  }
}

/**
 * Lance implausível é da fonte, não do parser. Sem esta marca, um único
 * erro de digitação no site do leiloeiro encabeça a ordenação "maior lance".
 */
export function isBidSuspect(bid?: number | null, appraisal?: number | null): boolean {
  if (bid == null || bid <= 0) return false;
  if (appraisal && appraisal > 0 && bid > appraisal * 20) return true;
  // Lance baixo demais também é lixo da fonte, não pechincha. A Copart entra
  // com R$ 50 em lote agendado: contra uma avaliação de R$ 98.637 isso vira
  // "-100%" verde no card, e a ordenação por desconto ficava inteira tomada
  // por esses. O portão antigo só olhava para cima.
  if (appraisal && appraisal > 1000 && bid < appraisal * 0.02) return true;
  return bid > 3_000_000;
}

export interface UpsertOutcome {
  upserted: number;
  /** Ids dos lotes vistos pela PRIMEIRA vez: é o gatilho dos alertas. */
  novos: number[];
  bidChanges: Array<{ lotId: number; sourceId: string; externalId: string; title: string; oldBid: number | null; newBid: number }>;
}

/**
 * Upsert por (source_id, external_id). Quando o lance muda, grava histórico
 * e devolve a mudança: é isso que o websocket publica como "lance ao vivo".
 */
export async function upsertLots(lots: CanonicalLot[]): Promise<UpsertOutcome> {
  const client = await pool.connect();
  const bidChanges: UpsertOutcome['bidChanges'] = [];
  const novos: number[] = [];
  let upserted = 0;
  try {
    await client.query('BEGIN');
    for (const l of lots) {
      // Scrub aqui, e não em cada conector, para que nenhuma fonte nova
      // possa esquecer de mascarar. O título gravado já sai limpo.
      const scrubbed = scrubPlates(l.titleRaw);
      const titleRaw = scrubbed.text;
      const plateMasked = l.plateMasked ?? scrubbed.plateMasked;
      const version = l.version ? scrubPlates(l.version).text : null;
      const searchText = buildSearchText([titleRaw, l.brand, l.model, version, l.city, l.state, l.sellerName]);
      const bidSuspect = isBidSuspect(campos.dinheiro(l.currentBid) ?? campos.dinheiro(l.minBid), campos.dinheiro(l.appraisal));
      const cls = classifyAsset(titleRaw, l.sourceCategory, l.sourceGroup);
      // O conector, quando sabe, manda o tipo de bem explícito e ele vence.
      const assetType = l.assetType ?? cls.assetType;
      // Imóvel nunca carrega tipo de veículo: sem esta trava, "Sala Comercial"
      // herdava 'carro' do classificador e entrava no filtro de veículo.
      const vehicleType = assetType === 'veiculo' ? (l.vehicleType ?? cls.vehicleType) : null;
      // Espelho do de cima: veículo nunca carrega tipo de imóvel.
      const propertyType =
        assetType === 'imovel' ? (l.propertyType ?? classifyProperty(titleRaw, l.sourceCategory)) : null;

      // Toda saída de conector passa por aqui antes de virar linha. Consertar
      // caixa, código de combustível e categoria-no-lugar-de-documentação em
      // cada conector seria consertar doze vezes a mesma coisa.
      const n = {
        city: campos.caixaDeTitulo(l.city),
        state: campos.uf(l.state),
        color: campos.cor(l.color),
        fuel: campos.combustivel(l.fuel),
        docType: campos.docType(l.docType),
        yearMake: campos.ano(l.yearMake),
        yearModel: campos.ano(l.yearModel),
        km: campos.km(l.km),
        currentBid: campos.dinheiro(l.currentBid),
        minBid: campos.dinheiro(l.minBid),
        bidIncrement: campos.dinheiro(l.bidIncrement),
        appraisal: campos.dinheiro(l.appraisal),
        lotUrl: campos.url(l.lotUrl),
        yard: campos.texto(l.yard),
        sellerName: campos.texto(l.sellerName),
        auctioneerName: campos.texto(l.auctioneerName),
        photos: campos.fotos(l.photos),
      };
      // O que não é documentação era categoria mandada no campo errado: em vez
      // de descartar, cai em source_category, que é onde sempre foi o lugar.
      const sourceCategory = campos.texto(l.sourceCategory) ?? (l.docType && !n.docType ? campos.texto(l.docType) : null);
      const area = Number(
        (l.raw as any)?.areaPrivativa ?? (l.raw as any)?.areaTotal ?? (l.raw as any)?.areaTerreno ?? NaN,
      );
      const titleDisplay =
        assetType === 'imovel'
          ? campos.tituloImovel({
              propertyType,
              area: Number.isFinite(area) ? area : null,
              city: n.city,
              state: n.state,
              neighborhood: campos.bairroDoTitulo(titleRaw, n.city),
              titleRaw,
            })
          : campos.tituloVeiculo({ brand: l.brand, model: l.model, version, yearMake: n.yearMake, yearModel: n.yearModel, titleRaw });
      const prev = await client.query<{ id: string; current_bid: number | null }>(
        'SELECT id, current_bid FROM lots WHERE source_id=$1 AND external_id=$2',
        [l.sourceId, l.externalId],
      );
      const res = await client.query<{ id: string }>(
        `INSERT INTO lots (
           source_id, external_id, lot_url, title_raw, brand, model, version, year_make, year_model,
           km, color, fuel, plate_masked, doc_type, closing_model, auction_start_utc, auction_end_utc,
           source_tz, status, current_bid, min_bid, bid_increment, appraisal, fees_pct, fees_amount,
           auctioneer_name, auctioneer_reg, seller_name, seller_type, yard, city, state, lat, lon,
           photos, photo_count, financeable, has_report, raw, search_text, bid_suspect,
           asset_type, vehicle_type, source_category, property_type, city_key, title_display, collected_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
           $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47, now()
         )
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           lot_url=EXCLUDED.lot_url, title_raw=EXCLUDED.title_raw, brand=EXCLUDED.brand, model=EXCLUDED.model,
           version=EXCLUDED.version, year_make=EXCLUDED.year_make, year_model=EXCLUDED.year_model, km=EXCLUDED.km,
           color=EXCLUDED.color, fuel=EXCLUDED.fuel, plate_masked=EXCLUDED.plate_masked, doc_type=EXCLUDED.doc_type,
           closing_model=EXCLUDED.closing_model, auction_start_utc=EXCLUDED.auction_start_utc,
           auction_end_utc=EXCLUDED.auction_end_utc, source_tz=EXCLUDED.source_tz, status=EXCLUDED.status,
           current_bid=EXCLUDED.current_bid, min_bid=EXCLUDED.min_bid, bid_increment=EXCLUDED.bid_increment,
           appraisal=EXCLUDED.appraisal, fees_pct=EXCLUDED.fees_pct, fees_amount=EXCLUDED.fees_amount,
           auctioneer_name=EXCLUDED.auctioneer_name, auctioneer_reg=EXCLUDED.auctioneer_reg,
           seller_name=EXCLUDED.seller_name, seller_type=EXCLUDED.seller_type, yard=EXCLUDED.yard,
           city=EXCLUDED.city, state=EXCLUDED.state, photos=EXCLUDED.photos, photo_count=EXCLUDED.photo_count,
           financeable=EXCLUDED.financeable, has_report=EXCLUDED.has_report, raw=EXCLUDED.raw,
           search_text=EXCLUDED.search_text, bid_suspect=EXCLUDED.bid_suspect,
           asset_type=EXCLUDED.asset_type, vehicle_type=EXCLUDED.vehicle_type,
           source_category=EXCLUDED.source_category, property_type=EXCLUDED.property_type,
           city_key=EXCLUDED.city_key, title_display=EXCLUDED.title_display, collected_at=now()
         RETURNING id`,
        [
          l.sourceId, l.externalId, n.lotUrl, titleRaw, l.brand ?? null, l.model ?? null,
          version, n.yearMake, n.yearModel, n.km, n.color,
          n.fuel, plateMasked, n.docType, l.closingModel,
          l.auctionStartUtc ?? null, l.auctionEndUtc ?? null, l.sourceTz, l.status,
          n.currentBid, n.minBid, n.bidIncrement, n.appraisal,
          l.feesPct ?? null, l.feesAmount ?? null, n.auctioneerName, l.auctioneerReg ?? null,
          n.sellerName, l.sellerType ?? null, n.yard, n.city, n.state,
          l.lat ?? null, l.lon ?? null, JSON.stringify(n.photos), n.photos.length,
          l.financeable ?? null, l.hasReport ?? null, JSON.stringify(l.raw ?? {}), searchText, bidSuspect,
          assetType, vehicleType, sourceCategory, propertyType, chaveCidade(n.city), titleDisplay,
        ],
      );
      upserted++;
      const lotId = Number(res.rows[0].id);
      if (!prev.rows.length) novos.push(lotId);
      const oldBid = prev.rows[0]?.current_bid ?? null;
      if (l.currentBid != null && Number(oldBid) !== Number(l.currentBid)) {
        await client.query('INSERT INTO bid_history (lot_id, bid) VALUES ($1,$2)', [lotId, l.currentBid]);
        if (prev.rows.length) {
          bidChanges.push({
            lotId,
            sourceId: l.sourceId,
            externalId: l.externalId,
            title: titleRaw,
            oldBid: oldBid == null ? null : Number(oldBid),
            newBid: Number(l.currentBid),
          });
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { upserted, bidChanges, novos };
}

/** Todo filtro de lista aceita string única, CSV ou array — a tela manda CSV. */
type Multi = string | string[] | undefined;

export interface SearchParams {
  q?: string;
  uf?: Multi;
  status?: Multi;
  sellerType?: Multi;
  sourceId?: Multi;
  /** Nome do leiloeiro como a fonte publica; só ~57% dos lotes trazem. */
  auctioneer?: Multi;
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
  /** Por padrão a busca esconde lote encerrado; a tela de cobertura pede o contrário. */
  includeEnded?: boolean;
  sort?: 'ending_soon' | 'price_asc' | 'price_desc' | 'recent' | 'discount';
  page?: number;
  pageSize?: number;
}

export interface SearchResponse {
  total: number;
  page: number;
  pageSize: number;
  interpreted: { brand: string | null; model: string | null; freeTerms: string[] };
  items: any[];
  facets: { states: any[]; cities: any[]; sources: any[]; sellerTypes: any[]; assetTypes: any[]; vehicleTypes: any[]; propertyTypes: any[]; auctioneers: any[]; statuses: any[] };
}

/**
 * A busca roda no nosso índice, nunca é repassada à fonte.
 * Quando marca e modelo são reconhecidos, o filtro é ESTRUTURAL (igualdade),
 * e não trigram: é isso que impede "mercedes b 200" de trazer GLA 200.
 */
export async function searchLots(p: SearchParams): Promise<SearchResponse> {
  const parsed = parseQuery(p.q ?? '');

  // Cada filtro carrega a chave da faceta que ele representa. Isso permite
  // montar, para CADA faceta, um WHERE que ignora o próprio filtro — sem isso
  // a lista de opções encolhe para o valor já escolhido e o usuário não
  // consegue trocar de "moto" para "caminhão" (a opção simplesmente some).
  interface Pred {
    sql: string;
    value?: any;
    facet?: string;
  }
  const preds: Pred[] = [];
  const P = (sql: string, value?: any, facet?: string) => preds.push({ sql, value, facet });

  if (parsed.brand) P('brand = ?', parsed.brand);
  if (parsed.model) P('model = ?', parsed.model);
  for (const t of parsed.freeTerms) P('search_text LIKE ?', `%${t}%`);
  if (!parsed.brand && !parsed.model && parsed.freeTerms.length === 0 && parsed.compactTerm) {
    P('search_text LIKE ?', `%${parsed.compactTerm}%`);
  }

  // A regra de vencimento mora em encerramento.ts, que é quem a GRAVA uma vez
  // por minuto. Manter uma cópia aqui faria a listagem (que filtra) divergir do
  // status gravado (que a página do lote lê) — foi exatamente esse o defeito.
  // O filtro continua aqui como rede: entre dois minutos do job há lote que
  // acabou de vencer e ainda não foi gravado.

  /** 'a,b' e ['a','b'] viram a mesma lista; string única vira lista de um. */
  const lista = (v: Multi): string[] =>
    (Array.isArray(v) ? v : String(v ?? '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean);

  /**
   * Um item vira igualdade, vários viram ANY. Igualdade contra a lista inteira
   * ('carro,suv') nunca casa e é um filtro que falha em silêncio — foi assim
   * que o alerta de Kardian ficou mudo.
   */
  const PLista = (col: string, v: Multi, facet?: string, mapa?: (x: string) => string) => {
    const vals = lista(v).map((x) => (mapa ? mapa(x) : x));
    if (vals.length === 1) P(`${col} = ?`, vals[0], facet);
    else if (vals.length > 1) P(`${col} = ANY(?)`, vals, facet);
    return vals;
  };

  PLista('state', p.uf, 'states', (x) => x.toUpperCase());

  const statuses = lista(p.status);
  if (statuses.length) {
    // 'encerrado' na seleção precisa arrastar o que venceu pela hora, senão o
    // lote de pregão que passou some das duas pontas: não está 'encerrado' na
    // fonte e o NOT VENCIDO o excluiria.
    const querEncerrado = statuses.includes('encerrado');
    const alvo = statuses.length === 1 ? `status = ${'?'}` : `status = ANY(${'?'})`;
    const valor: any = statuses.length === 1 ? statuses[0] : statuses;
    if (querEncerrado) P(`(${alvo} OR ${VENCIDO})`, valor, 'statuses');
    else {
      P(alvo, valor, 'statuses');
      P(`NOT ${VENCIDO}`, undefined, 'statuses');
    }
  } else if (!p.includeEnded) {
    P(`status <> 'encerrado'`);
    P(`NOT ${VENCIDO}`);
  }

  PLista('seller_type', p.sellerType, 'sellerTypes');
  PLista('source_id', p.sourceId, 'sources');
  PLista('auctioneer_name', p.auctioneer, 'auctioneers');
  if (p.assetType) P('asset_type = ?', p.assetType, 'assetTypes');
  const tiposVeiculo = PLista('vehicle_type', p.vehicleType, 'vehicleTypes');
  PLista('property_type', p.propertyType, 'propertyTypes');
  PLista('city_key', p.city, 'cities');
  // Peça e lote misto não são o produto: só aparecem se pedidos de propósito.
  if (!p.assetType && !tiposVeiculo.length) P(`asset_type <> 'outro'`);
  if (p.priceMin != null) P('COALESCE(current_bid, min_bid) >= ?', p.priceMin);
  if (p.priceMax != null) P('COALESCE(current_bid, min_bid) <= ?', p.priceMax);
  if (p.yearMin != null) P('year_model >= ?', p.yearMin);
  if (p.yearMax != null) P('year_model <= ?', p.yearMax);
  if (p.onlyWithDate) P('(auction_start_utc IS NOT NULL OR auction_end_utc IS NOT NULL)');
  if (p.onlyWithPhoto) P('photo_count > 0');

  /** Monta WHERE e parâmetros, opcionalmente pulando os filtros de uma faceta. */
  function build(excluirFacet?: string): { sql: string; params: any[] } {
    const parts: string[] = [];
    const params: any[] = [];
    for (const pred of preds) {
      if (excluirFacet && pred.facet === excluirFacet) continue;
      if (pred.value === undefined) {
        parts.push(pred.sql);
      } else {
        params.push(pred.value);
        parts.push(pred.sql.replace('?', `$${params.length}`));
      }
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
  }

  const main = build();
  const whereSql = main.sql;
  const params = main.params;

  // O `, id` no fim NÃO é decoração: 250 lotes compartilham a mesma data de
  // encerramento e 500 o mesmo first_seen_at. Sem desempate estável, a
  // paginação repetia 17 itens e sumia com outros 17.
  const sortKey =
    p.sort === 'price_asc'
      ? 'COALESCE(current_bid, min_bid) ASC NULLS LAST'
      : p.sort === 'price_desc'
        ? 'bid_suspect ASC, COALESCE(current_bid, min_bid) DESC NULLS LAST'
        : p.sort === 'recent'
          ? 'first_seen_at DESC'
          : p.sort === 'discount'
            ? 'bid_suspect ASC, CASE WHEN appraisal > 0 AND COALESCE(current_bid,min_bid) > 0 THEN COALESCE(current_bid,min_bid)/appraisal ELSE 9 END ASC'
            : 'COALESCE(auction_end_utc, auction_start_utc) ASC NULLS LAST';
  // O desempate acompanha o sentido da ordenação: em "mais recentes", lotes
  // gravados no mesmo segundo têm de sair do último para o primeiro, senão a
  // primeira página mostra o começo do lote em vez do fim.
  const sort = `${sortKey}, id ${p.sort === 'recent' || p.sort === 'price_desc' ? 'DESC' : 'ASC'}`;

  const page = Math.max(1, p.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, p.pageSize ?? 24));
  const offset = (page - 1) * pageSize;

  const [{ count }] = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM lots ${whereSql}`, params);
  const items = await query(
    `SELECT id, source_id, external_id, lot_url, title_raw, title_display, brand, model, version, year_make, year_model,
            km, doc_type, closing_model, auction_start_utc, auction_end_utc, source_tz, status,
            current_bid, min_bid, bid_increment, appraisal, fees_pct, bid_suspect, asset_type, vehicle_type, property_type,
            source_category, auctioneer_name, auctioneer_reg,
            COALESCE((raw->>'areaPrivativa')::numeric, (raw->>'areaTotal')::numeric, (raw->>'areaTerreno')::numeric) AS area,
            (raw->>'quartos')::int AS rooms,
            seller_name, seller_type, yard, city, state, photos, photo_count, financeable, has_report,
            collected_at, first_seen_at,
            first_seen_at > now() - interval '24 hours' AS is_novo,
            CASE WHEN ${VENCIDO} THEN 'encerrado' ELSE status END AS effective_status,
            CASE WHEN appraisal > 0 AND COALESCE(current_bid,min_bid) > 0
                 THEN ROUND((1 - COALESCE(current_bid,min_bid)/appraisal) * 100) ELSE NULL END AS discount_pct
     FROM lots ${whereSql} ORDER BY ${sort} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  async function facet(col: string, key: string, limit = 20) {
    const b = build(key);
    const w = b.sql ? `${b.sql} AND` : 'WHERE';
    return query(
      `SELECT ${col} AS value, COUNT(*)::int AS count FROM lots ${w} ${col} IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`,
      b.params,
    );
  }

  /**
   * Cidade tem rótulo próprio: o agrupamento é pela chave sem acento, mas o que
   * aparece na tela tem de ser a grafia correta. Entre "CUIABA", "CUIABÁ" e
   * "Cuiabá", ganha a que não é toda maiúscula e tem mais acento.
   */
  async function facetCidade() {
    // Só faz sentido com UF escolhida: são 1.552 cidades no índice, e uma lista
    // desse tamanho não é filtro, é outro problema. O agrupamento também custa.
    if (!lista(p.uf).length) return [];
    const b = build('cities');
    const w = b.sql ? `${b.sql} AND` : 'WHERE';
    const semAcento = `translate(city,'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç','AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')`;
    return query(
      `SELECT city_key AS value, COUNT(*)::int AS count,
              (array_agg(city ORDER BY (city = upper(city)), (length(city) - length(${semAcento})) DESC, city))[1] AS label
         FROM lots ${w} city_key IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 300`,
      b.params,
    );
  }

  const [states, cities, sources, sellerTypes, assetTypes, vehicleTypes, propertyTypes, auctioneers, statusesFacet] = await Promise.all([
    facet('state', 'states', 30),
    facetCidade(),
    facet('source_id', 'sources'),
    facet('seller_type', 'sellerTypes'),
    facet('asset_type', 'assetTypes'),
    facet('vehicle_type', 'vehicleTypes'),
    facet('property_type', 'propertyTypes'),
    facet('auctioneer_name', 'auctioneers', 80),
    // Situação conta pelo status EFETIVO: lote de pregão cuja hora passou
    // aparece como aberto na coluna e como encerrado na tela.
    facet(`CASE WHEN ${VENCIDO} THEN 'encerrado' ELSE status END`, 'statuses', 10),
  ]);

  return {
    total: count,
    page,
    pageSize,
    interpreted: { brand: parsed.brand, model: parsed.model, freeTerms: parsed.freeTerms },
    items,
    facets: { states, cities, sources, sellerTypes, assetTypes, vehicleTypes, propertyTypes, auctioneers, statuses: statusesFacet },
  };
}

export async function getLot(id: number) {
  const [lot] = await query('SELECT * FROM lots WHERE id = $1', [id]);
  if (!lot) return null;
  const history = await query('SELECT bid, observed_at FROM bid_history WHERE lot_id=$1 ORDER BY observed_at DESC LIMIT 30', [id]);
  return { ...lot, bid_history: history };
}

export async function getStats() {
  const [totals] = await query<any>(`
    SELECT COUNT(*)::int AS lots,
           COUNT(*) FILTER (WHERE status='aberto')::int AS abertos,
           COUNT(*) FILTER (WHERE status='agendado')::int AS agendados,
           COUNT(*) FILTER (WHERE status='sem_data')::int AS sem_data,
           COUNT(*) FILTER (WHERE auction_end_utc IS NOT NULL)::int AS com_fim,
           COUNT(*) FILTER (WHERE km IS NOT NULL)::int AS com_km,
           COUNT(*) FILTER (WHERE current_bid IS NOT NULL)::int AS com_lance,
           COUNT(DISTINCT brand)::int AS marcas,
           COUNT(*) FILTER (WHERE asset_type='veiculo')::int AS veiculos,
           COUNT(*) FILTER (WHERE asset_type='imovel')::int AS imoveis,
           COUNT(*) FILTER (WHERE asset_type='outro')::int AS outros
    FROM lots`);
  const bySource = await query(`
    SELECT l.source_id, s.name, COUNT(*)::int AS lots,
           COUNT(*) FILTER (WHERE l.auction_end_utc IS NOT NULL)::int AS com_fim,
           COUNT(*) FILTER (WHERE l.current_bid IS NOT NULL)::int AS com_lance,
           COUNT(*) FILTER (WHERE l.km IS NOT NULL)::int AS com_km,
           MAX(l.collected_at) AS ultima_coleta
    FROM lots l JOIN sources s ON s.id = l.source_id GROUP BY 1,2 ORDER BY 3 DESC`);
  const runs = await query(`
    SELECT source_id, job, started_at, finished_at, ok, fetched, upserted, skipped, error, http_status
    FROM collection_runs ORDER BY started_at DESC LIMIT 20`);
  return { totals, bySource, runs };
}

export async function startRun(sourceId: string, job: string, limite?: number): Promise<number> {
  const [row] = await query<{ id: string }>(
    'INSERT INTO collection_runs (source_id, job, limite) VALUES ($1,$2,$3) RETURNING id',
    [sourceId, job, limite ?? null],
  );
  return Number(row.id);
}

export async function finishRun(
  id: number,
  data: { ok: boolean; fetched?: number; upserted?: number; skipped?: number; error?: string; httpStatus?: number },
) {
  await query(
    `UPDATE collection_runs SET finished_at=now(), ok=$2, fetched=$3, upserted=$4, skipped=$5, error=$6, http_status=$7 WHERE id=$1`,
    [id, data.ok, data.fetched ?? 0, data.upserted ?? 0, data.skipped ?? 0, data.error ?? null, data.httpStatus ?? null],
  );
}
