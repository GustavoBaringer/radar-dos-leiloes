/**
 * Plataforma **Ares** (white-label "Agência Ares") — SPA React 19 + Tailwind
 * servida de `https://<dominio>/` que fala com um backend Supabase/PostgREST
 * no próprio domínio de API (`https://api.<dominio>/rest/v1/...`).
 *
 * MEDIDO em 03/10/2026 nos 4 tenants:
 *
 * - A chave anon vai embutida no JS da home: `sb_publishable_...` em
 *   `https://api.<dominio>` + `apikey`/`Authorization: Bearer`.
 * - Tabela pública do catálogo: `public_lots` (select com `title, status,
 *   evaluation_value, highest_bid_value, address, featured_image_url, ...`).
 * - Status medidos em campo: `aberto`, `futuro`, `encerrado`, `vendido`,
 *   `retirado`, `pendente`. Só `aberto`/`futuro` entram (lotes ativos).
 * - Fases do leilão em `lot_phases` (`start_date`/`end_date` ISO com offset).
 * - URL do lote no portal: `https://<dominio>/lote/{id}`.
 *
 * Mesmo contrato nos 4 tenants (mesmo bundle JS, hashes idênticos), então
 * um parser só: `conectorDaPlataforma` por tenant.
 */
import { fetchJson } from './http.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ATIVOS: LotStatus[] = ['aberto', 'agendado'];
const STATUS: Record<string, LotStatus> = {
  aberto: 'aberto',
  futuro: 'agendado',
  encerrado: 'encerrado',
  vendido: 'vendido',
  retirado: 'encerrado',
  pendente: 'sem_data',
};

/**
 * Tipo do bem pelo RÓTULO da categoria (`categories.name`), como em
 * suaplataforma — o enum da fonte não é estável entre tenants. Título serve
 * de desempate; sem pista nenhuma é 'outro', nunca 'veiculo'.
 */
function tipoDoBem(categoria: string | null, titulo: string): AssetType {
  const c = `${categoria ?? ''} ${titulo}`.toLowerCase();
  if (/ve[ií]cul|autom[óo]v|\bcarro|moto|caminh[ãa]o|[ôo]nibus|trator|m[áa]quina/.test(c)) return 'veiculo';
  if (/resid|terreno|comerc|industri|im[óo]v|rural|apartament|\bcasa|galp[ãa]o|loja|fazenda/.test(c)) return 'imovel';
  return 'outro';
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Fim da fase mais tardia / início da mais cedo — as fases já vêm com offset +00:00. */
function datasDasFases(fases: any[] | null): { inicio: Date | null; fim: Date | null } {
  const list = (fases ?? []).filter((f) => f?.start_date || f?.end_date);
  if (!list.length) return { inicio: null, fim: null };
  const inicios = list.map((f) => Date.parse(f.start_date)).filter(Number.isFinite);
  const fins = list.map((f) => Date.parse(f.end_date)).filter(Number.isFinite);
  return {
    inicio: inicios.length ? new Date(Math.min(...inicios)) : null,
    fim: fins.length ? new Date(Math.max(...fins)) : null,
  };
}

function conectorDaPlataforma(cfg: {
  id: string;
  nome: string;
  host: string;
  apiKey: string;
  tier: number;
}): Connector {
  return {
    def: {
      id: cfg.id,
      name: cfg.nome,
      platform: 'Ares (Supabase/PostgREST)',
      method: 'api',
      tier: cfg.tier,
      siteUrl: `https://${cfg.host}`,
      notes: `Catálogo em https://api.${cfg.host}/rest/v1/public_lots (status aberto/futuro); lote em /lote/{id}.`,
    },
    async collect({ limit }): Promise<CollectResult> {
      const lots: CanonicalLot[] = [];
      const vistos = new Set<string>();
      let fetched = 0;
      let skipped = 0;
      let httpStatus = 0;
      const select = 'id,slug,title,lot_number,status,evaluation_value,highest_bid_value,bid_count,bid_increment,commission_percentage,address,featured_image_url,auction_id,hidden,categories(name),lot_phases(start_date,end_date,phase_order),auctions!auction_id(auctioneers!auctioneer_id(name))';

      for (let offset = 0; lots.length < limit; offset += Math.max(limit, 50)) {
        const url =
          `https://api.${cfg.host}/rest/v1/public_lots?select=${encodeURIComponent(select)}` +
          `&status=in.(aberto,futuro)&hidden=eq.false&order=created_at.desc&limit=${Math.max(limit, 50)}&offset=${offset}`;
        let r;
        try {
          r = await fetchJson<any[]>(url, {
            headers: { apikey: cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}` },
            gapMs: 1100,
          });
        } catch {
          break;
        }
        httpStatus = r.status;
        if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) break;
        fetched += r.data.length;

        for (const row of r.data) {
          if (lots.length >= limit) break;
          if (!row?.id || vistos.has(row.id)) continue;
          vistos.add(row.id);
          const titulo = String(row.title ?? '').replace(/\s+/g, ' ').trim();
          if (!titulo || looksLikePart(titulo)) {
            skipped++;
            continue;
          }
          const categoria = row.categories?.name ?? null;
          const assetType = tipoDoBem(categoria, titulo);
          const parsed = assetType === 'veiculo' ? parseTitle(titulo) : null;
          const local = campos.localDeTexto(row.address) ?? campos.localDeTexto(titulo);
          const fases = datasDasFases(row.lot_phases);
          const status = STATUS[String(row.status ?? '').toLowerCase()] ?? 'sem_data';
          if (!ATIVOS.includes(status)) {
            skipped++;
            continue;
          }

          const leiloeiro =
            row.auctions?.auctioneers?.name ??
            row.auction?.auctioneers?.name ??
            row.auctioneers?.name ??
            row.auctioneer?.name ??
            null;
          lots.push({
            sourceId: cfg.id,
            externalId: String(row.id),
            lotUrl: `https://${cfg.host}/lote/${row.id}`,
            titleRaw: titulo,
            brand: parsed?.brand ?? null,
            model: parsed?.model ?? null,
            version: parsed?.version ?? null,
            yearMake: parsed?.yearMake ?? null,
            yearModel: parsed?.yearModel ?? null,
            assetType,
            sourceCategory: categoria,
            docType: null,
            closingModel: 'timer_por_lote',
            auctionStartUtc: fases.inicio,
            auctionEndUtc: fases.fim,
            sourceTz: 'America/Sao_Paulo',
            status,
            currentBid: num(row.highest_bid_value),
            minBid: num(row.highest_bid_value) ?? num(row.evaluation_value),
            appraisal: num(row.evaluation_value),
            bidIncrement: num(row.bid_increment),
            feesPct: num(row.commission_percentage),
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: row.featured_image_url ? [row.featured_image_url] : [],
            auctioneerName: leiloeiro ? String(leiloeiro).trim() : null,
            raw: { statusFonte: row.status, auctionId: row.auction_id, lotNumber: row.lot_number },
          });
        }
        // Página curta = fim do catálogo ativo.
        if (r.data.length < Math.max(limit, 50)) break;
      }
      return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
    },
  };
}

export const albertomacedo = conectorDaPlataforma({
  id: 'albertomacedo',
  nome: 'Alberto Macedo Leilões',
  host: 'albertomacedoleiloes.com.br',
  apiKey: 'sb_publishable_q4YiofZr6g5KgA7P-F6QCw_YpTZjua_',
  tier: 3,
});

export const bigleilao = conectorDaPlataforma({
  id: 'bigleilao',
  nome: 'Big Leilão',
  host: 'bigleilao.com.br',
  apiKey: 'sb_publishable_Vwzsqq_-p7D-hfqnmlFsdw_Nsh3lL9q',
  tier: 3,
});

export const clebercardosoleiloes = conectorDaPlataforma({
  id: 'clebercardosoleiloes',
  nome: 'Cleber Cardoso Leilões',
  host: 'clebercardosoleiloes.com.br',
  apiKey: 'sb_publishable__sWLlPfxN2fVW9jgkIT39w_oAyBC-Ej',
  tier: 3,
});

export const cunhaleiloeiro = conectorDaPlataforma({
  id: 'cunhaleiloeiro',
  nome: 'Cunha Leiloeiro',
  host: 'cunhaleiloeiro.com.br',
  apiKey: 'sb_publishable_-9Hgjbq1X_N614naMFSPHA_h1LMqujK',
  tier: 3,
});

/** Os 4 tenants do mesmo parser — o `index.ts` pode espalhar esta lista. */
export const supraTenants: Connector[] = [albertomacedo, bigleilao, clebercardosoleiloes, cunhaleiloeiro];
