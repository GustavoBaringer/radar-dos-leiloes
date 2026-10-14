import { Inject, Injectable } from '@nestjs/common';
import { BRAND_LIST } from '../../../domain/lots/normalize.js';
import type { SearchParams } from '../../../domain/search/search-params.js';
import { getLot, getStats, searchLots, searchLotsMapa, type RespostaMapa, type SearchResponse } from './lots.repository.js';
import { auctioneerSiteNameSql, lotSiteHostSql } from './lots.repository.js';

export const CATALOG_QUERY = 'CATALOG_QUERY';
export type CatalogQuery = (sql: string, params?: unknown[]) => Promise<any[]>;

const CARD_COLUMNS = `id, title_raw, title_display, source_id, lot_url,
  ${auctioneerSiteNameSql()} AS auctioneer_site_name,
  ${lotSiteHostSql()} AS auctioneer_domain,
  asset_type, vehicle_type, property_type, source_category, status, city, state, km, doc_type, photos,
  brand, model, year_make, year_model, current_bid, min_bid, appraisal, bid_suspect,
  auction_end_utc, auction_start_utc, closing_model, auctioneer_name,
  COALESCE((raw->>'areaPrivativa')::numeric, (raw->>'areaTotal')::numeric, (raw->>'areaTerreno')::numeric) AS area,
  (raw->>'quartos')::int AS rooms,
  first_seen_at > now() - interval '24 hours' AS is_novo,
  CASE WHEN appraisal > 0 AND COALESCE(current_bid,min_bid) > 0
       THEN ROUND((1 - COALESCE(current_bid,min_bid)/appraisal) * 100) ELSE NULL END AS discount_pct`;

const ABERTOS = `status IN ('aberto','agendado','sem_data')`;
const CATEGORIAS = [
  { id: 'carro', label: 'Carros', icone: 'carro', query: 'vehicleType=carro', where: `vehicle_type='carro'` },
  { id: 'suv', label: 'SUVs', icone: 'carro', query: 'vehicleType=suv', where: `vehicle_type='suv'` },
  { id: 'moto', label: 'Motos', icone: 'moto', query: 'vehicleType=moto', where: `vehicle_type='moto'` },
  { id: 'picape', label: 'Picapes', icone: 'caminhao', query: 'vehicleType=picape', where: `vehicle_type='picape'` },
  { id: 'caminhao', label: 'Caminhões', icone: 'caminhao', query: 'vehicleType=caminhao', where: `vehicle_type='caminhao'` },
  { id: 'imovel', label: 'Imóveis', icone: 'casa', query: 'assetType=imovel', where: `asset_type='imovel'` },
] as const;

@Injectable()
export class CatalogRepository {
  constructor(@Inject(CATALOG_QUERY) private readonly query: CatalogQuery) {}

  search(input: SearchParams): Promise<SearchResponse> {
    return searchLots(input, this.query);
  }

  searchMap(input: SearchParams): Promise<RespostaMapa> {
    return searchLotsMapa(input, this.query);
  }

  detail(id: number, interno: boolean) {
    return getLot(id, { interno }, this.query);
  }

  stats() {
    return getStats(this.query);
  }

  async home() {
    const [recentes, leiloeiros, [agregado], ufs] = await Promise.all([
      this.query(`SELECT ${CARD_COLUMNS}
        FROM lots WHERE status IN ('aberto','agendado') AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
        ORDER BY first_seen_at DESC, id DESC LIMIT 24`),
      this.query(`SELECT auctioneer_name AS nome, count(*)::int AS total FROM lots
        WHERE auctioneer_name IS NOT NULL AND auctioneer_name <> '' AND status IN ('aberto','agendado')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
      this.query(`SELECT count(DISTINCT source_id)::int AS fontes, count(*)::int AS total,
        (SELECT count(*)::int FROM auctioneers WHERE domain IS NOT NULL AND domain <> '') AS "totalLeiloeiros"
        FROM lots WHERE status IN ('aberto','agendado','sem_data')`),
      this.query(`SELECT state AS uf, count(*)::int AS total FROM lots
        WHERE state IS NOT NULL AND status IN ('aberto','agendado','sem_data') GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return { recentes, leiloeiros, ...agregado, ufs };
  }

  homeLeiloeiro(nome: string) {
    return this.query(`SELECT ${CARD_COLUMNS} FROM lots
      WHERE auctioneer_name = $1 AND status IN ('aberto','agendado')
      ORDER BY (photos IS NOT NULL AND jsonb_array_length(photos) > 0) DESC, first_seen_at DESC LIMIT 24`, [nome]);
  }

  async vitrine() {
    const [agregados, ufs, categorias, leiloeiros, recentes, encerrando, porHora, fotosCat, heroes] = await Promise.all([
      this.query(`SELECT count(DISTINCT source_id)::int AS fontes, count(*)::int AS total,
        (SELECT count(*)::int FROM auctioneers WHERE domain IS NOT NULL AND domain <> '') AS "totalLeiloeiros",
        count(*) FILTER (WHERE first_seen_at > now() - interval '24 hours')::int AS "novos24h",
        count(*) FILTER (WHERE closing_model = 'timer_por_lote' AND auction_end_utc BETWEEN now() AND now() + interval '24 hours')::int AS "encerram24h"
        FROM lots WHERE ${ABERTOS}`),
      this.query(`SELECT state AS uf, count(*)::int AS total FROM lots WHERE state IS NOT NULL AND ${ABERTOS} GROUP BY 1 ORDER BY 2 DESC`),
      this.query(`SELECT ${CATEGORIAS.map((c, i) => `count(*) FILTER (WHERE ${c.where})::int AS c${i}`).join(', ')} FROM lots WHERE ${ABERTOS}`),
      this.query(`SELECT auctioneer_name AS nome, count(*)::int AS total FROM lots
        WHERE auctioneer_name IS NOT NULL AND auctioneer_name <> '' AND ${ABERTOS} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      this.query(`SELECT ${CARD_COLUMNS} FROM (
        SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY first_seen_at DESC, id DESC) AS n
        FROM lots WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
      ) t WHERE n <= 2 ORDER BY first_seen_at DESC, id DESC LIMIT 8`),
      this.query(`SELECT id, title_display, title_raw, city, state, current_bid, min_bid, auction_end_utc
        FROM lots WHERE status IN ('aberto','agendado') AND closing_model = 'timer_por_lote' AND auction_end_utc > now()
        ORDER BY auction_end_utc ASC LIMIT 5`),
      this.query(`SELECT h, count(l.id)::int AS total FROM generate_series(1, 12) AS h
        LEFT JOIN lots l ON l.closing_model = 'timer_por_lote' AND l.status IN ('aberto','agendado')
          AND l.auction_end_utc >= now() + (h - 1) * interval '1 hour'
          AND l.auction_end_utc < now() + h * interval '1 hour'
        GROUP BY h ORDER BY h`),
      this.query(`SELECT DISTINCT ON (cat) cat, photos->>0 AS foto FROM (
        SELECT CASE WHEN asset_type = 'imovel' THEN 'imovel' ELSE vehicle_type END AS cat, photos, first_seen_at, id
        FROM lots WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
      ) t WHERE cat IN (${CATEGORIAS.map((c) => `'${c.id}'`).join(',')}) ORDER BY cat, first_seen_at DESC, id DESC`),
      this.query(`SELECT ${CARD_COLUMNS} FROM (
        SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY first_seen_at DESC, id DESC) AS n
        FROM lots WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
          AND (current_bid IS NOT NULL OR min_bid IS NOT NULL) AND NOT bid_suspect
      ) t WHERE n <= 2 ORDER BY first_seen_at DESC, id DESC LIMIT 3`),
    ]);
    return { agregados: agregados[0] ?? {}, ufs, categorias: categorias[0] ?? {}, leiloeiros, recentes, encerrando, porHora, fotosCat, heroes };
  }

  sources() {
    return this.query(`SELECT s.*, COUNT(l.id)::int AS lots, MAX(l.collected_at) AS ultima_coleta
      FROM sources s LEFT JOIN lots l ON l.source_id = s.id GROUP BY s.id ORDER BY s.tier, s.name`);
  }

  brands() {
    return this.query('SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC')
      .then((present) => ({ known: BRAND_LIST, present }));
  }

}
