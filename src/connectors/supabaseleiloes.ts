import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { classifyAsset, classifySeller, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';

interface PublicLot {
  id: string; slug?: string; title?: string; description?: string; address?: string;
  status?: string; evaluation_value?: number; highest_bid_value?: number; bid_increment?: number;
  commission_percentage?: number; featured_image_url?: string; lot_phases?: Array<{ start_date?: string; end_date?: string; announced_value?: number }>;
}

function status(v?: string): LotStatus {
  if (/aberto|futuro|agendado/i.test(v ?? '')) return /futuro|agendado/i.test(v ?? '') ? 'agendado' : 'aberto';
  if (/vendido|arrematado/i.test(v ?? '')) return 'vendido';
  return 'encerrado';
}

function conector(cfg: { id: string; name: string; host: string; key: string; siteUrl: string }): Connector {
  return {
    def: { id: cfg.id, name: cfg.name, platform: 'Supabase Leilões', method: 'api', tier: 3, siteUrl: cfg.siteUrl, notes: 'API pública PostgREST exposta pelo frontend; coleta public_lots e fases.' },
    async collect({ limit }): Promise<CollectResult> {
      const url = `https://${cfg.host}/rest/v1/public_lots?select=${encodeURIComponent('*,lot_phases(*)')}&status=in.(aberto,futuro)&hidden=eq.false&order=created_at.desc&limit=${Math.min(limit, 1000)}`;
      let r;
      try { r = await fetchText(url, { headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}` }, gapMs: 900 }); } catch { return { lots: [], fetched: 0, skipped: 0, httpStatus: 0 }; }
      if (r.status !== 200) return { lots: [], fetched: 0, skipped: 0, httpStatus: r.status };
      let rows: PublicLot[] = [];
      try { rows = JSON.parse(r.body); } catch { return { lots: [], fetched: 0, skipped: 0, httpStatus: r.status }; }
      let skipped = 0;
      const lots = rows.flatMap((x): CanonicalLot[] => {
        const text = `${x.title ?? ''} ${x.description ?? ''}`.replace(/<[^>]+>/g, ' ');
        if (!x.title || looksLikePart(text)) { skipped++; return []; }
        const parsed = parseTitle(x.title);
        const kind = classifyAsset(text);
        const phases = x.lot_phases ?? [];
        const active = phases.at(-1);
        const local = campos.localDeTexto(`${x.address ?? ''} ${text}`);
        return [{
          sourceId: cfg.id, externalId: x.id, lotUrl: `${cfg.siteUrl.replace(/\/$/, '')}/lote/${x.slug ?? x.id}`,
          titleRaw: x.title, brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
          assetType: kind.assetType, vehicleType: kind.vehicleType, closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: status(x.status),
          auctionStartUtc: active?.start_date ? new Date(active.start_date) : null, auctionEndUtc: active?.end_date ? new Date(active.end_date) : null,
          currentBid: Number(x.highest_bid_value) || null, minBid: Number(active?.announced_value) || null, appraisal: Number(x.evaluation_value) || null,
          bidIncrement: Number(x.bid_increment) || null, feesPct: Number(x.commission_percentage) || null, sellerType: classifySeller(null) as any,
          city: local?.city ?? null, state: local?.uf ?? null, photos: x.featured_image_url ? [x.featured_image_url] : [], raw: { tenant: cfg.siteUrl, api: 'public_lots' },
        }];
      });
      return { lots, fetched: rows.length, skipped, httpStatus: r.status };
    },
  };
}

export const rocketleiloes = conector({ id: 'rocketleiloes', name: 'Rocket Leilões', host: 'api.rocketleiloes.com.br', key: 'sb_publishable_FIAmv6wqk3yAGFuBYcHJxA_wBzd2vbh', siteUrl: 'https://www.rocketleiloes.com.br' });
export const savoyleiloes = conector({ id: 'savoyleiloes', name: 'Savoy Leilões', host: 'api.savoyleiloes.com.br', key: 'sb_publishable__NGN6fHZ_XB-PWeVqYDgjA_nHEmpnNB', siteUrl: 'https://www.savoyleiloes.com.br' });
