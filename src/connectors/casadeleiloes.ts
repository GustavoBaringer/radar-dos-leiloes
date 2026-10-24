import { fetchTenantText, TenantScopeError } from './http.js';
import type { FetchResult } from './http.js';
import type { Connector, CollectOptions, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { CollectionCancellationError } from '../infra/collection/collection-cancellation.js';

const HOST = 'https://www.casadeleiloes.com.br';
const TENANT_HOST = 'casadeleiloes.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type CasaIO = { fetchTenantText?: typeof fetchTenantText };

function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function tenantURL(value: string, base: string): URL {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || normalizeHost(url.hostname) !== TENANT_HOST) {
    throw new TenantScopeError(`URL fora do tenant Casa de Leilões: ${url.href}`);
  }
  return url;
}

function rethrowScopeOrCancellation(error: unknown): void {
  if (error instanceof TenantScopeError || error instanceof CollectionCancellationError || (error instanceof Error && error.name === 'AbortError')) {
    throw error;
  }
}

function eventoPaths(html: string): { paths: string[]; total: number } {
  const paths = new Set<string>();
  for (const match of html.matchAll(/href=['"]([^'"]*\/leilao\/[^'"]+)['"]/gi)) {
    const url = tenantURL(match[1], HOST);
    paths.add(`${url.pathname}${url.search}`);
  }
  return { paths: [...paths], total: paths.size };
}

function mapCard(cardHtml: string, evento: string): CanonicalLot | null {
  const href = /\bhref=['"]([^'"]+)['"]/i.exec(cardHtml)?.[1];
  if (!href) return null;
  const url = tenantURL(href, HOST);
  const id = url.pathname.startsWith('/lote/') ? url.pathname.match(/\/(\d+)$/)?.[1] : null;
  if (!id) return null;
  const titulo = strip(cardHtml.match(/<blockquote>([\s\S]*?)<\/blockquote>/i)?.[1] ?? '');
  if (!titulo || looksLikePart(titulo)) return null;

  const atualLabel = cardHtml.match(/Lance atual\s*:\s*R\$\s*([\d.,]+)/i)?.[1];
  const inicialLabel = cardHtml.match(/Lance inicial\s*:\s*R\$\s*([\d.,]+)/i)?.[1];
  const photoRaw = cardHtml.match(/data-src=['"]([^'"]+)['"]/i)?.[1]
    ?? cardHtml.match(/<img[^>]+src=['"]([^'"]+)['"]/i)?.[1]
    ?? null;
  const foto = photoRaw && !/\/imagens\/tr\.gif$/i.test(photoRaw) ? photoRaw : null;
  const parsed = parseTitle(titulo);
  const local = campos.localDeTexto(titulo);

  return {
    sourceId: 'casadeleiloes',
    externalId: id,
    lotUrl: url.href,
    auctioneerName: 'Casa de Leilões',
    titleRaw: titulo,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    assetType: /im[óo]vel|apartamento|casa|terreno|fazenda/i.test(titulo) ? 'imovel' : parsed.brand ? 'veiculo' : 'outro',
    closingModel: 'pregao_em_horario',
    auctionStartUtc: null,
    auctionEndUtc: null,
    sourceTz: 'America/Sao_Paulo',
    status: 'sem_data',
    currentBid: dinheiro(atualLabel),
    minBid: dinheiro(inicialLabel),
    sellerType: classifySeller(null) as any,
    city: local?.city ?? null,
    state: local?.uf ?? null,
    photos: foto ? [foto.startsWith('http') ? foto : `${HOST}${foto}`] : [],
    raw: { evento },
  };
}

export async function collectCasa({ limit, tenant }: CollectOptions, io: CasaIO = {}): Promise<CollectResult> {
  if (tenant !== undefined && normalizeHost(tenant) !== TENANT_HOST) {
    throw new TenantScopeError(`single-tenant '${tenant}' fora da população elegível de casadeleiloes`);
  }
  const fetch = io.fetchTenantText ?? fetchTenantText;
  const lots: CanonicalLot[] = [];
  const vistos = new Set<string>();
  let fetched = 0;
  let skipped = 0;
  let httpStatus = 0;
  const partial: string[] = [];
  let home: FetchResult;
  try { home = await fetch(`${HOST}/`, TENANT_HOST, { headers: { 'user-agent': UA }, gapMs: 1100 }); }
  catch (error) {
    rethrowScopeOrCancellation(error);
    return { lots, fetched, skipped, httpStatus, note: `parcial: falha requisitando home: ${error instanceof Error ? error.message : String(error)}` };
  }
  httpStatus = home.status;
  if (home.status !== 200) return { lots, fetched, skipped, httpStatus, note: `parcial: home respondeu HTTP ${home.status}` };

  const { paths: eventos } = eventoPaths(home.body);
  for (const ev of eventos) {
    if (lots.length >= limit) { partial.push('limite de lotes atingido'); break; }
    let r: FetchResult;
    try { r = await fetch(`${HOST}${ev}`, TENANT_HOST, { headers: { 'user-agent': UA }, gapMs: 1100 }); }
    catch (error) {
      rethrowScopeOrCancellation(error);
      partial.push(`falha requisitando evento ${ev}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    httpStatus = r.status;
    if (r.status !== 200) { partial.push(`evento ${ev} respondeu HTTP ${r.status}`); continue; }

    for (const match of r.body.matchAll(/<a class=['"]lote-lista['"][\s\S]*?<\/a>/gi)) {
      if (lots.length >= limit) { partial.push('limite de lotes atingido'); break; }
      const rawHref = /\bhref=['"]([^'"]+)['"]/i.exec(match[0])?.[1];
      const rawPath = rawHref ? tenantURL(rawHref, HOST).pathname : '';
      const rawId = rawPath.startsWith('/lote/') ? rawPath.match(/\/(\d+)$/)?.[1] : null;
      if (!rawId || vistos.has(rawId)) continue;
      vistos.add(rawId);
      fetched++;
      const lot = mapCard(match[0], ev);
      if (!lot) { skipped++; continue; }
      lots.push(lot);
      if (lots.length >= limit && limit > 0) partial.push('limite de lotes atingido');
    }
  }
  return { lots, fetched, skipped, httpStatus, ...(partial.length ? { note: `parcial: ${[...new Set(partial)].join('; ')}` } : {}) };
}

export const casadeleiloes: Connector = {
  def: {
    id: 'casadeleiloes',
    name: 'Casa de Leilões',
    platform: 'Casa de Leilões ASP.NET',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Host fixo; percorre eventos descobertos na home. Valores identificados pelos rótulos Lance atual e Lance inicial; status/data não inferidos.',
  },
  collect: collectCasa,
};
