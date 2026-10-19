import { Inject, Injectable } from '@nestjs/common';
import { VENCIDO } from '../queries/lot-status.js';
import { VISIBLE_FAVORITE_PREDICATE } from './account-context.repository.js';
import { auctioneerSiteNameSql, lotSiteHostSql } from './lots.repository.js';

export const ACCOUNTS_QUERY = 'ACCOUNTS_QUERY';
export type AccountsQuery = (sql: string, params?: unknown[]) => Promise<any[]>;

@Injectable()
export class AccountsRepository {
  constructor(@Inject(ACCOUNTS_QUERY) private readonly query: AccountsQuery) {}

  listAlerts(ownerId: number, limit: number, offset: number) {
    return Promise.all([
      this.query('SELECT count(*)::int AS total FROM alerts WHERE owner_id = $1', [ownerId]),
      this.query(`SELECT a.id, a.label, a.q, a.channels, a.email, a.filters,
          (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id) AS total,
          (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id AND NOT h.seen) AS nao_vistos
        FROM alerts a WHERE a.owner_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`, [ownerId, limit, offset]),
    ]);
  }

  createAlert(data: { ownerId: number; label: string; q: string | null; filters: unknown; channels: string[]; email: string | null }) {
    return this.query(`INSERT INTO alerts (label, q, filters, channels, email, owner_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, label, q, channels, email, filters`,
    [data.label, data.q, JSON.stringify(data.filters), data.channels, data.email, data.ownerId]);
  }

  updateAlert(data: { id: number; ownerId: number; label: string | null; channels: string[]; email: string | null }) {
    return this.query(`UPDATE alerts SET label = COALESCE($2, label), channels = $3, email = $4
      WHERE id = $1 AND owner_id = $5 RETURNING id, label, q, channels, email, filters`,
    [data.id, data.label, data.channels, data.email, data.ownerId]);
  }

  alertHitCounts(alertId: number) {
    return this.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT seen)::int AS nao_vistos FROM alert_hits WHERE alert_id = $1', [alertId]);
  }

  deleteAlert(id: number, ownerId: number) {
    return this.query('DELETE FROM alerts WHERE id = $1 AND owner_id = $2 RETURNING id', [id, ownerId]);
  }

  async listAlertHits(ownerId: number, naoVistos: boolean, alertId: number | null, limit: number, offset: number) {
    const base = `SELECT l.id, l.source_id, l.lot_url,
        ${auctioneerSiteNameSql('l.lot_url')} AS auctioneer_site_name,
        ${lotSiteHostSql('l.lot_url')} AS auctioneer_domain,
        l.title_raw, l.title_display, l.auctioneer_name, l.brand, l.model, l.year_make, l.year_model,
        l.km, l.doc_type, l.closing_model, l.auction_start_utc, l.auction_end_utc, l.status,
        l.current_bid, l.min_bid, l.appraisal, l.bid_suspect, l.asset_type, l.vehicle_type,
        l.source_category, l.property_type, l.city, l.state, l.photos, l.photo_count,
        COALESCE((l.raw->>'areaPrivativa')::numeric, (l.raw->>'areaTotal')::numeric, (l.raw->>'areaTerreno')::numeric) AS area,
        (l.raw->>'quartos')::int AS rooms,
        CASE WHEN l.appraisal > 0 AND COALESCE(l.current_bid,l.min_bid) > 0
             THEN ROUND((1 - COALESCE(l.current_bid,l.min_bid)/l.appraisal) * 100) ELSE NULL END AS discount_pct,
        bool_and(h.seen) AS seen, max(h.created_at) AS hit_em,
        array_agg(DISTINCT a.label ORDER BY a.label) AS labels, count(*)::int AS alertas
      FROM alert_hits h JOIN alerts a ON a.id = h.alert_id JOIN lots l ON l.id = h.lot_id
      WHERE a.owner_id = $1 ${naoVistos ? 'AND NOT h.seen' : ''}
        ${alertId === null ? '' : 'AND a.id = $2'}
        AND l.status NOT IN ('encerrado','vendido') AND NOT ${VENCIDO}
      GROUP BY l.id`;
    const params = alertId === null ? [ownerId] : [ownerId, alertId];
    const [{ total }] = await this.query(`SELECT count(*)::int AS total FROM (${base}) grouped`, params);
    const rows = await this.query(`${base} ORDER BY max(h.created_at) DESC, l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]);
    return { total: Number(total), rows };
  }

  markAlertHitsSeen(ownerId: number, alertId: number | null) {
    return this.query(`UPDATE alert_hits SET seen = TRUE
      WHERE NOT seen AND alert_id IN (SELECT id FROM alerts WHERE owner_id = $1)
      ${alertId === null ? '' : 'AND alert_id = $2'}`,
    alertId === null ? [ownerId] : [ownerId, alertId]);
  }

  async listFavorites(ownerId: number, limit: number, offset: number) {
    const base = `SELECT l.id, l.source_id, l.lot_url,
        ${auctioneerSiteNameSql('l.lot_url')} AS auctioneer_site_name,
        ${lotSiteHostSql('l.lot_url')} AS auctioneer_domain,
        l.title_raw, l.title_display, l.auctioneer_name, l.brand, l.model, l.year_make, l.year_model,
        l.km, l.doc_type, l.closing_model, l.auction_start_utc, l.auction_end_utc, l.status,
        l.current_bid, l.min_bid, l.appraisal, l.bid_suspect, l.asset_type, l.vehicle_type,
        l.source_category, l.property_type, l.city, l.state, l.photos, l.photo_count,
        COALESCE((l.raw->>'areaPrivativa')::numeric, (l.raw->>'areaTotal')::numeric, (l.raw->>'areaTerreno')::numeric) AS area,
        (l.raw->>'quartos')::int AS rooms,
        CASE WHEN l.appraisal > 0 AND COALESCE(l.current_bid,l.min_bid) > 0
             THEN ROUND((1 - COALESCE(l.current_bid,min_bid)/l.appraisal) * 100) ELSE NULL END AS discount_pct,
        f.created_at AS favorited_em
      FROM favorites f JOIN lots l ON l.id = f.lot_id
      WHERE f.owner_id = $1 AND ${VISIBLE_FAVORITE_PREDICATE}`;
    const [{ total }] = await this.query(`SELECT count(*)::int AS total FROM favorites f JOIN lots l ON l.id = f.lot_id
      WHERE f.owner_id = $1 AND ${VISIBLE_FAVORITE_PREDICATE}`, [ownerId]);
    const rows = await this.query(`${base} ORDER BY f.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`, [ownerId, limit, offset]);
    return { total: Number(total), rows };
  }

  addFavorite(ownerId: number, lotId: number) {
    return this.query('INSERT INTO favorites (owner_id, lot_id) VALUES ($1,$2) ON CONFLICT (owner_id, lot_id) DO NOTHING', [ownerId, lotId]);
  }

  deleteFavorite(ownerId: number, lotId: number) {
    return this.query('DELETE FROM favorites WHERE owner_id = $1 AND lot_id = $2', [ownerId, lotId]);
  }

  waitlist(data: { email: string; nome: string; interesse: string; consentimento: string }) {
    return this.query(`INSERT INTO espera (email, nome, interesse, consentimento)
      VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4) ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
    [data.email, data.nome, data.interesse, data.consentimento]);
  }

  register(data: { nome: string; documento: string; tipoDocumento: 'CPF' | 'CNPJ'; email: string; celular: string; versao: string; consentimento: string; ip: string | null; marketing: boolean; origem: string }) {
    return this.query(`INSERT INTO cadastros
      (nome, cpf_cnpj, tipo_documento, email, celular, consentimento_termos_em, consentimento_versao,
       consentimento_texto, consentimento_ip, consentimento_marketing, origem)
      VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8,$9, NULLIF($10,''))
      ON CONFLICT DO NOTHING RETURNING id`,
    [data.nome, data.documento, data.tipoDocumento, data.email, data.celular, data.versao,
      data.consentimento, data.ip, data.marketing, data.origem]);
  }

  subscribe(data: { endpoint: string; p256dh: string; auth: string; userAgent: string; ownerId: number }) {
    return this.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, owner_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth, failures=0, owner_id=EXCLUDED.owner_id`,
    [data.endpoint, data.p256dh, data.auth, data.userAgent, data.ownerId]);
  }

  subscriptions(ownerId: number) {
    return this.query('SELECT endpoint, failures, created_at FROM push_subscriptions WHERE owner_id = $1 ORDER BY created_at', [ownerId]);
  }
}
