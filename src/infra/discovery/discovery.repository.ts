import { Injectable } from '@nestjs/common';
import { query } from '../database/query.js';
import { LOT_SITE_HOST_SQL, startRun, finishRun } from '../database/repositories/lots.repository.js';

export const UPSERT_AUCTIONEER_FENAJU_SQL = `
  INSERT INTO auctioneers (registry, external_id, name, matricula, junta, uf, situacao, domain, domain_origin,
                            uf_junta, ano_posse, credenciamento, associado, nivel, dominio_leilao)
  VALUES ('fenaju',$1,$2,$3,$4,$5,$6,$7,$8,$5,$9,$10,$11,$12,$13)
  ON CONFLICT (registry, external_id) DO UPDATE SET
    name=EXCLUDED.name, matricula=EXCLUDED.matricula, junta=EXCLUDED.junta, uf=EXCLUDED.uf,
    situacao=EXCLUDED.situacao,
    domain=CASE WHEN auctioneers.domain_origin='reconciliado_site_fenaju' AND coalesce(auctioneers.domain,'') <> ''
                THEN auctioneers.domain ELSE EXCLUDED.domain END,
    domain_origin=CASE WHEN auctioneers.domain_origin='reconciliado_site_fenaju' AND coalesce(auctioneers.domain,'') <> ''
                       THEN auctioneers.domain_origin ELSE EXCLUDED.domain_origin END,
    uf_junta=EXCLUDED.uf_junta, ano_posse=EXCLUDED.ano_posse, credenciamento=EXCLUDED.credenciamento,
    associado=EXCLUDED.associado, nivel=EXCLUDED.nivel, dominio_leilao=EXCLUDED.dominio_leilao,
    collected_at=now()
  WHERE auctioneers.domain_origin IS DISTINCT FROM 'reconciliado_site_fenaju'
     OR coalesce(auctioneers.domain,'') = ''
     OR (auctioneers.name IS NOT DISTINCT FROM EXCLUDED.name
         AND auctioneers.matricula IS NOT DISTINCT FROM EXCLUDED.matricula
         AND auctioneers.junta IS NOT DISTINCT FROM EXCLUDED.junta
         AND auctioneers.uf IS NOT DISTINCT FROM EXCLUDED.uf
         AND auctioneers.uf_junta IS NOT DISTINCT FROM EXCLUDED.uf_junta)
  RETURNING domain`;

export interface DiscoveryRepositoryPort {
  startRun(sourceId: string, job: string): Promise<number>;
  finishRun(id: number, result: { ok: boolean; fetched?: number; upserted?: number; skipped?: number; error?: string }): Promise<unknown>;
  upsertAuctioneer(params: unknown[]): Promise<{ domain: string | null } | undefined>;
  upsertSite(domain: string, count: number, ufs: string[]): Promise<unknown>;
  siteCounts(): Promise<{ total: number; pendentes: number }>;
  sites(limite: number): Promise<Array<{ domain: string; platform: string | null }>>;
  sitesByDomains(domains: string[]): Promise<Array<{ domain: string; platform: string | null }>>;
  hasLots(domain: string): Promise<boolean>;
  updateProbe(domain: string, probe: { status: number; hasLots: boolean | null; platform: string | null; title: string | null; note: string | null }, connector: string | null): Promise<unknown>;
}

@Injectable()
export class DiscoveryRepository implements DiscoveryRepositoryPort {
  startRun(sourceId: string, job: string) { return startRun(sourceId, job); }
  finishRun(id: number, result: { ok: boolean; fetched?: number; upserted?: number; skipped?: number; error?: string }) { return finishRun(id, result); }

  async upsertAuctioneer(params: unknown[]) {
    const [row] = await query<{ domain: string | null }>(UPSERT_AUCTIONEER_FENAJU_SQL, params);
    return row;
  }

  upsertSite(domain: string, count: number, ufs: string[]) {
    return query(`INSERT INTO discovered_sites (domain, auctioneers, ufs) VALUES ($1,$2,$3)
      ON CONFLICT (domain) DO UPDATE SET auctioneers=EXCLUDED.auctioneers, ufs=EXCLUDED.ufs`, [domain, count, ufs]);
  }

  async siteCounts() {
    const [{ total }] = await query<{ total: number }>('SELECT count(*)::int AS total FROM discovered_sites');
    const [{ pendentes }] = await query<{ pendentes: number }>('SELECT count(*)::int AS pendentes FROM discovered_sites WHERE checked_at IS NULL');
    return { total, pendentes };
  }

  sites(limite: number) {
    return query<{ domain: string; platform: string | null }>(`SELECT domain, platform FROM discovered_sites
      ORDER BY checked_at ASC NULLS FIRST, auctioneers DESC LIMIT $1`, [limite]);
  }

  sitesByDomains(domains: string[]) {
    return query<{ domain: string; platform: string | null }>(
      'SELECT domain, platform FROM discovered_sites WHERE domain = ANY($1::text[])', [domains]);
  }

  async hasLots(domain: string) {
    const rows = await query<{ tem: boolean }>(`SELECT EXISTS(SELECT 1 FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1) AS tem`, [domain.toLowerCase()]);
    return rows[0]?.tem === true;
  }

  updateProbe(domain: string, r: { status: number; hasLots: boolean | null; platform: string | null; title: string | null; note: string | null }, connector: string | null) {
    return query(`UPDATE discovered_sites
      SET http_status=$2, has_lots=$3, platform=COALESCE(discovered_sites.platform, $4),
          connector_id=COALESCE(discovered_sites.connector_id, $5), title=$6, note=$7, checked_at=now()
      WHERE domain=$1`, [domain, r.status, r.hasLots, r.platform, connector, r.title, r.note]);
  }
}
