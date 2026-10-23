import { fetchText } from './http.js';
import type { Connector, CollectResult, CollectOptions } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import type { TenantAttempt } from '../domain/collection/tenant-attempts.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FlexTenantConfig {
  key: 'flex' | 'vz';
  domain: string;
  name: string;
  origin: string;
  prefixId: boolean;
}

export const FLEX_TENANTS: Record<string, FlexTenantConfig> = {
  'flexleiloes.com.br': {
    key: 'flex',
    domain: 'flexleiloes.com.br',
    name: 'FlexLeilões',
    origin: 'https://www.flexleiloes.com.br',
    prefixId: false,
  },
  'vzleiloes.com.br': {
    key: 'vz',
    domain: 'vzleiloes.com.br',
    name: 'VZ Leilões',
    origin: 'https://www.vzleiloes.com.br',
    prefixId: true,
  },
};

export function resolveFlexTenant(tenant?: string): FlexTenantConfig | null {
  if (!tenant) return null;
  const n = tenant.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').trim();
  if (n === 'flex' || n === 'flexleiloes.com.br') return FLEX_TENANTS['flexleiloes.com.br'];
  if (n === 'vz' || n === 'vzleiloes.com.br') return FLEX_TENANTS['vzleiloes.com.br'];
  return null;
}

function texto(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function dinheiro(v?: string | null): number | null {
  const clean = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!clean) return null;
  const normalized = clean.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
  const n = Number(normalized);
  return isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})h(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/suspens|cancelad|encerrad|finalizad/.test(t)) return 'encerrado';
  if (/lances a partir/.test(t)) return 'agendado';
  if (/aberto|lance/.test(t)) return 'aberto';
  return 'sem_data';
}

export interface ParsedFlexCard {
  id: string;
  title: string;
  desc: string;
  datas: string[];
  lances: number[];
  avaliacao: number | null;
  andamento: string;
  foto: string | null;
}

export function parseFlexCards(html: string): ParsedFlexCard[] {
  const cards: ParsedFlexCard[] = [];
  for (const bloco of html.split('<a href="lotes/').slice(1)) {
    const id = bloco.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const corte = bloco.slice(0, 2600);
    const title = texto(corte.match(/<h2 class="item-titulo">([\s\S]*?)<\/h2>/)?.[1] ?? '');
    const desc = corte.match(/<div class="item-descricao">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const datas = [...desc.matchAll(/\d[º°]? LEILÃO:\s*(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}h\d{2})/gi)].map((m) => m[1]);
    const lances = [...desc.matchAll(/Lance Mínimo:\s*R\$\s*([\d.,]+)/gi)].map((m) => dinheiro(m[1])).filter((n): n is number => !!n);
    const avaliacao = dinheiro(desc.match(/Avalia[cç][ãa]o:\s*R\$\s*([\d.,]+)/i)?.[1]);
    const andamento = texto(corte.match(/<div class="item-andamento">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const foto = corte.match(/<img[^>]+src=([^\s>]+)/)?.[1]?.replace(/['"]/g, '') ?? null;
    cards.push({ id, title, desc, datas, lances, avaliacao, andamento, foto });
  }
  return cards;
}

export function mapFlexLot(card: ParsedFlexCard, tenant: FlexTenantConfig): CanonicalLot | null {
  if (!card.title || looksLikePart(card.title)) return null;
  const parsed = parseTitle(card.title);
  const local = campos.localDeTexto(card.title);
  const externalId = tenant.prefixId ? `vz:${card.id}` : card.id;
  const lotUrl = `${tenant.origin}/lotes/${card.id}`;
  const isImovel = /im[óo]vel|apartamento|casa|terreno|garagem|pr[eé]dio|galp[ãa]o|sala/i.test(card.title);
  const propertyType = isImovel
    ? /apartamento/i.test(card.title) ? 'apartamento'
      : /casa|sobrado/i.test(card.title) ? 'casa'
      : /terreno|lote/i.test(card.title) ? 'terreno'
      : /garagem/i.test(card.title) ? 'vaga'
      : /comercial|sala|galp[ãa]o|pr[eé]dio/i.test(card.title) ? 'comercial'
      : undefined
    : undefined;
  const assetType = isImovel ? 'imovel' : parsed.brand ? 'veiculo' : 'outro';
  if (assetType === 'outro') return null;
  const foto = card.foto ? (card.foto.startsWith('http') ? card.foto : `${tenant.origin}/${card.foto.replace(/^\//, '')}`) : null;

  return {
    sourceId: 'flexleiloes',
    externalId,
    lotUrl,
    auctioneerName: tenant.name,
    titleRaw: card.title,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    assetType,
    propertyType,
    closingModel: 'timer_por_lote',
    auctionStartUtc: dataBr(card.datas[0]),
    auctionEndUtc: dataBr(card.datas[card.datas.length - 1]) ?? dataBr(card.datas[0]),
    sourceTz: 'America/Sao_Paulo',
    status: statusDe(card.andamento),
    minBid: card.lances[card.lances.length - 1] ?? card.lances[0] ?? null,
    appraisal: card.avaliacao,
    sellerType: classifySeller(null) as any,
    city: local?.city ?? null,
    state: local?.uf ?? null,
    photos: foto ? [foto] : [],
    raw: { tenant: tenant.domain, andamento: card.andamento },
  };
}

export async function collectFlexTenant(
  tenant: FlexTenantConfig,
  limit: number,
  fetch = fetchText,
  observer?: TenantAttempt,
): Promise<CollectResult> {
  const lots: CanonicalLot[] = [];
  const seen = new Set<string>();
  const notes: string[] = ['catálogo parcial: listagem pública home sem total anunciado'];
  let fetched = 0, skipped = 0, httpStatus = 0;

  throwIfCancelled();
  let r;
  try {
    r = await fetch(`${tenant.origin}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
  } catch (error) {
    throwIfCancelled();
    if (error instanceof CollectionCancellationError) throw error;
    observer?.failure('network');
    return {
      lots,
      fetched,
      skipped,
      httpStatus,
      note: `${tenant.domain}: falha de rede (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  observer?.response(r.status);
  httpStatus = r.status;
  if (r.status !== 200) {
    return {
      lots,
      fetched,
      skipped,
      httpStatus,
      note: `${tenant.domain}: HTTP ${r.status}`,
    };
  }

  const cards = parseFlexCards(r.body);
  let truncated = false;
  for (const card of cards) {
    throwIfCancelled();
    if (lots.length >= limit) {
      truncated = true;
      break;
    }
    fetched++;
    if (seen.has(card.id)) {
      skipped++;
      continue;
    }
    seen.add(card.id);
    const lot = mapFlexLot(card, tenant);
    if (!lot) {
      skipped++;
      continue;
    }
    lots.push(lot);
  }

  if (truncated || lots.length >= limit) {
    notes.push('limite de coleta atingido; catálogo truncado');
  }

  return { lots, fetched, skipped, httpStatus, note: notes.join('; ') };
}

export const flexleiloes: Connector = {
  def: {
    id: 'flexleiloes',
    name: 'FlexLeilões',
    platform: 'FlexLeilões',
    method: 'html',
    tier: 3,
    siteUrl: 'https://www.flexleiloes.com.br',
    notes: 'Home server-rendered multi-tenant (SoftGT). Coleta FlexLeilões e VZ Leilões preservando IDs legados Flex e prefixo vz: em VZ.',
  },
  async collect({ limit, tenant, observer }: CollectOptions, io = { fetchText }): Promise<CollectResult> {
    const fetch = io.fetchText;
    let targetTenants: FlexTenantConfig[];
    if (tenant) {
      const resolved = resolveFlexTenant(tenant);
      if (!resolved) {
        throw new Error(`single-tenant '${tenant}' fora da população elegível de flexleiloes`);
      }
      targetTenants = [resolved];
    } else {
      targetTenants = [FLEX_TENANTS['flexleiloes.com.br'], FLEX_TENANTS['vzleiloes.com.br']];
    }

    const lots: CanonicalLot[] = [];
    const notes: string[] = [];
    let fetched = 0, skipped = 0, httpStatus = 0;

    for (const t of targetTenants) {
      if (lots.length >= limit) break;
      const attempt = await observer?.start(t.domain);
      const antes = lots.length;
      try {
        const res = await collectFlexTenant(t, limit - lots.length, fetch, attempt);
        lots.push(...res.lots);
        fetched += res.fetched;
        skipped += res.skipped;
        httpStatus = res.httpStatus ?? httpStatus;
        if (res.note) notes.push(res.note);
        await attempt?.finish({
          fetched: res.fetched,
          skipped: res.skipped,
          returned: res.lots.length,
          truncated: res.lots.length >= limit - antes,
        });
      } catch (err) {
        if (err instanceof CollectionCancellationError) throw err;
        await attempt?.finish({ fetched: 0, skipped: 0, returned: 0, truncated: false });
        throw err;
      }
    }
    return {
      lots: lots.slice(0, limit),
      fetched,
      skipped,
      httpStatus,
      note: notes.length ? [...new Set(notes)].join('; ') : undefined,
    };
  },
};
