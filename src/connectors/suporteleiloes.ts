/**
 * Plataforma **Suporte Leilões** — white-label multi-tenant, HTML com JSON embutido.
 *
 * Duas gerações de front-end convivem no mesmo backend: v1 (Laravel, 89 dos 107
 * domínios) e v2 (Next.js/RSC, 2 domínios). Este conector implementa a **v1**,
 * onde mora o volume; a v2 fica documentada em `specs/suporte-leiloes.md` e
 * pendente — 2 tenants não justificam o parser do protocolo Flight agora.
 *
 * O dado vem do `<script>var lote = {...}</script>` da página de detalhe e dos
 * cards da busca. Não há API pública: `api-v2.suporteleiloes.com.br` responde
 * 401 mesmo com Referer e Origin do tenant.
 */
import * as cheerio from 'cheerio';
import { fetchText, fetchTenantText, TenantScopeError } from './http.js';
import { query } from '../core/db.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';
import * as campos from '../core/campos.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import { classifyAsset, classifySeller } from '../core/normalize.js';
import { eventoEncerrado, eventosAtivos, eventNextPages, ofertaLinks, parseSuporteOferta, parseSuporteDetalhe } from './suporte-oferta.js';
import type { TenantAttempt } from '../core/tenant-attempts.js';
import { CollectionCancellationError, throwIfCancelled } from '../core/collection-cancellation.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
/** 1 = Veículos, 2 = Imóveis. Confirmado idêntico em 6 tenants. */
const CATEGORIAS: Array<[number, AssetType]> = [[1, 'veiculo'], [2, 'imovel']];
const POR_PAGINA = 12;

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Tenants genuínos.
 *
 * `platform='suporte-leiloes'` NÃO serve como lista: o regex da descoberta usa
 * `\.leilao\.br`, que é sufixo genérico, e marcou **superbid.net** — o maior
 * player do mercado, que já tem conector próprio. Coletá-lo aqui duplicaria o
 * catálogo dele com um parser feito para outra plataforma.
 *
 * A assinatura real é o CDN compartilhado no HTML da home.
 */
const FORA = new Set(['superbid.net', 'mercadoleiloes.com.br', 'confiancaleiloes.leilao.br', 'e-leiloeiro.leilao.br', 'magalhaesleiloes.com.br']);
export const FOLLOWUP_TENANTS = new Set([
  'leiloespb.com.br', 'colossoleiloes.com.br', 'atlanticoleiloes.com.br', 'marcotulioleiloes.com.br',
  'vlleiloes.com.br', 'leiloesmonteiro.com.br', 'maglianoleiloes.com.br',
  // Contrato v1 atual: `/leiloes` não enumera os cards; o crawler público lê
  // também `/buscador`, onde os lotes são publicados.
  'buaizleiloes.com.br', 'esleiloes.com.br', 'suedpeterleiloes.com.br', 'emleilao.com.br',
  'renannerisleiloeiro.com.br', 'portoleiloes.com.br', 'leilaobrasil.com.br',
]);

async function eligibleTenants(limite: number, tenant?: string): Promise<string[]> {
  const explicitos = String(process.env.SUPORTELEILOES_DOMAINS ?? '').trim();
  const discovered = explicitos ? explicitos.split(',').map((d) => d.trim())
    : [...FOLLOWUP_TENANTS, ...(await query<{ domain: string }>(`SELECT domain FROM discovered_sites WHERE platform='suporte-leiloes' AND http_status=200 AND has_lots IS NOT FALSE ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`)).map(r => r.domain)];
  const candidates = [...new Set(discovered)].filter((d) => d && !FORA.has(d));
  const due = await dueTenants({ sourceId: 'suporteleiloes', candidates, limit: tenant ? Number.MAX_SAFE_INTEGER : limite, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  if (!tenant) return due;
  const selected = filterTenantPopulation(due, tenant);
  if (!selected.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de suporteleiloes`);
  return selected;
}

export async function collectOfertaTenant(host: string, limit: number, assetTypes: string[] | undefined, attempt: TenantAttempt | undefined,
  request: typeof fetchText = fetchText) {
  let fetched = 0, skipped = 0, lastStatus = 0, truncated = false;
  const lots: CanonicalLot[] = [], seen = new Set<string>(), events = new Map<string, string>();
  const homeEventUrls = new Set<string>();
  const get = async (url: string, record = true) => {
    throwIfCancelled();
    try { const r = await request(url, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 30000 }); lastStatus = r.status; if (record) attempt?.response(r.status); return r; }
    catch (error) {
      if (error instanceof CollectionCancellationError) throw error;
      attempt?.failure('network'); return null;
    }
  };
  const listing = await get(`https://${host}/leiloes`, false);
  let listingHtml = '';
  if (listing?.status === 200) {
    attempt?.response(listing.status);
    if (!ehSuporteLeiloes(listing.body)) {
      attempt?.failure('parser');
      return { lots, fetched, skipped, lastStatus, truncated };
    }
    listingHtml = listing.body;
    if (/Marco\s+Tul[ií]o/i.test(listing.body) && eventosAtivos(listingHtml, host).length === 0) {
      // This tenant returns a valid but structurally empty /leiloes page in some variants; only use live homepage cards/offers as fallback.
      const home = await get(`https://${host}/`);
      if (home?.status === 200 && ehSuporteLeiloes(home.body)) {
        ofertaLinks(home.body, host).forEach((url) => events.set(url, ''));
        eventosAtivos(home.body, host).forEach((url) => homeEventUrls.add(url));
      } else if (home?.status === 200) attempt?.failure('parser');
    }
  } else if (listing?.status === 404) {
    // /leiloes can be absent on older tenants; do not let this expected route miss poison a successful home fallback.
    const home = await get(`https://${host}/`);
    if (!home || home.status !== 200 || !ehSuporteLeiloes(home.body)) {
      if (home?.status === 200) attempt?.failure('parser');
      return { lots, fetched, skipped, lastStatus, truncated };
    }
    const homeOffers = ofertaLinks(home.body, host);
    const homeEvents = eventosAtivos(home.body, host);
    homeOffers.forEach((url) => events.set(url, ''));
    if (!homeOffers.length && !homeEvents.length && /marco\s+tu[lú]io/i.test(home.body)) {
      // The known Marco tenant omits active cards from home; only then inspect its legacy agenda, still filtering card status.
      const agenda = await get(`https://${host}/agenda`);
      if (agenda?.status === 200 && ehSuporteLeiloes(agenda.body)) listingHtml = agenda.body;
      else if (agenda?.status === 200) attempt?.failure('parser');
    } else {
      homeEvents.forEach((url) => homeEventUrls.add(url));
    }
  } else {
    if (listing) attempt?.response(listing.status);
    return { lots, fetched, skipped, lastStatus, truncated };
  }

  const eventUrls = [...new Set([...eventosAtivos(listingHtml, host), ...homeEventUrls])];
  for (const eventUrl of eventUrls) {
    throwIfCancelled();
    if (lots.length >= limit) { truncated = true; break; }
    const pages = [eventUrl], pageSeen = new Set<string>();
    while (pages.length && pageSeen.size < 10) {
      const pageUrl = pages.shift()!;
      if (pageSeen.has(pageUrl)) continue;
      pageSeen.add(pageUrl);
      const event = await get(pageUrl);
      if (!event || event.status !== 200) continue;
      if (eventoEncerrado(event.body)) continue;
      for (const url of ofertaLinks(event.body, host)) events.set(url, eventUrl);
      for (const next of eventNextPages(event.body, host, pageUrl)) if (!pageSeen.has(next)) pages.push(next);
      if (pages.length && pageSeen.size >= 10) truncated = true;
    }
  }
  // Alguns tenants atuais deixam `/leiloes` vazio (ou só com eventos fechados)
  // e publicam os lotes diretamente no buscador.
  if (!events.size) {
    const search = await get(`https://${host}/buscador`);
    if (search?.status === 200 && ehSuporteLeiloes(search.body)) {
      ofertaLinks(search.body, host).forEach((url) => events.set(url, ''));
    } else if (search?.status === 200) attempt?.failure('parser');
  }
  for (const [url] of events) {
    throwIfCancelled();
    if (lots.length >= limit) { truncated = true; break; }
    if (seen.has(url)) continue; seen.add(url);
    const r = await get(url);
    if (!r || r.status !== 200) { skipped++; continue; }
    fetched++;
    const lot = parseSuporteOferta(r.body, host, url);
    if (!lot || (assetTypes?.length && !assetTypes.includes(String(lot.assetType)))) { skipped++; continue; }
    lots.push(lot);
  }
  return { lots, fetched, skipped, lastStatus, truncated };
}

export async function collectSuporteTenant(host: string, limit: number, assetTypes: string[] | undefined,
  observer: import('../core/tenant-attempts.js').TenantObserver | undefined, request: typeof fetchText = fetchText) {
  const attempt = await observer?.start(host);
  const before = { fetched: 0, skipped: 0, returned: 0, truncated: false };
  try {
    const result = await collectOfertaTenant(host, limit, assetTypes, attempt, request);
    before.fetched = result.fetched;
    before.skipped = result.skipped;
    before.returned = result.lots.length;
    before.truncated = result.truncated || result.lots.length >= limit;
    return result;
  } catch (error) {
    if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
    else attempt?.failure('parser');
    throw error;
  } finally {
    await attempt?.finish(before);
  }
}

/** Discover event and lot links from the tenant's public pages; IDs are always page-derived. */
export async function collectDiscoveredTenant(host: string, limit: number, assetTypes?: string[], observer?: import('../core/tenant-attempts.js').TenantObserver,
  request: typeof fetchText = fetchText, lookupExisting?: (lotUrl: string, proposedId: string) => Promise<string | null | { collision: true }>) {
  const normalized = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const attempt = await observer?.start(normalized);
  const lots: CanonicalLot[] = [], seen = new Set<string>(), candidateUrls = new Set<string>(), candidateCategories = new Map<string, string>(), triedUrls = new Set<string>();
  const pageQueue = ['/', '/agenda', '/buscador', '/leiloes'];
  const pages = new Set<string>();
  let fetched = 0, skipped = 0, lastStatus = 0, partial = false;
  const get = async (url: string) => {
    throwIfCancelled();
    try {
      const r = await request(url, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 30000 });
      lastStatus = r.status; attempt?.response(r.status); return r;
    } catch (error) {
      if (error instanceof CollectionCancellationError) throw error;
      attempt?.failure('network'); partial = true; return null;
    }
  };
  const pageOrigin = `https://${host}`;
  const drainLots = async () => {
    for (const url of candidateUrls) {
      if (lots.length >= limit) return;
      if (triedUrls.has(url)) continue;
      triedUrls.add(url);
      throwIfCancelled();
      if (/\b(treino|treinamento|teste|demo)\b/i.test(decodeURIComponent(url))) { skipped++; continue; }
      const response = await get(url); fetched++;
      if (!response || response.status !== 200) { skipped++; partial = true; continue; }
      const lot = parseSuporteOferta(response.body, normalized, url) ?? parseSuporteDetalhe(response.body, normalized, url, candidateCategories.get(url));
      if (!lot || (assetTypes?.length && !assetTypes.includes(String(lot.assetType)))) { skipped++; partial = true; continue; }
      const identity = await lookupExisting?.(lot.lotUrl ?? url, lot.externalId);
      if (identity && typeof identity === 'object') { skipped++; partial = true; continue; }
      if (identity) lot.externalId = identity;
      if (seen.has(lot.externalId)) continue;
      seen.add(lot.externalId); lots.push(lot);
    }
  };
  try {
    while (pageQueue.length && lots.length < limit) {
      const path = pageQueue.shift()!;
      const pageUrl = new URL(path, pageOrigin).href;
      if (pages.has(pageUrl)) continue;
      pages.add(pageUrl);
      const response = await get(pageUrl);
      if (!response || response.status !== 200) {
        const basePage = ['/', '/agenda', '/buscador', '/leiloes'].includes(new URL(pageUrl).pathname);
        if (!response || response.status >= 500 || !basePage) partial = true;
        continue;
      }
      if (!ehSuporteLeiloes(response.body)) { if (path === '/') attempt?.failure('parser'); partial = true; continue; }
      const $ = cheerio.load(response.body);
      const eventText = `${$('title').text()} ${$('h1,h2').text()}`.toLowerCase();
      const eventPage = /\/eventos\/leilao\/|^\/leiloes\/\d+/.test(path);
      const training = /\b(treino|treinamento|teste|demo)\b/.test(eventText) || (eventPage && eventoEncerrado(response.body));
      if (!training) {
        for (const card of lerCards(response.body, host)) {
          if (new URL(card.url).hostname === new URL(pageOrigin).hostname) {
            candidateUrls.add(card.url);
            if (card.categoria) candidateCategories.set(card.url, card.categoria);
          }
        }
        for (const url of ofertaLinks(response.body, host)) candidateUrls.add(url);
        $('a[href]').each((_, a) => {
          const href = $(a).attr('href'); if (!href) return;
          const target = new URL(href, pageUrl);
          if (target.hostname !== new URL(pageOrigin).hostname) return;
          const p = target.pathname;
          if (/\/eventos\/leilao\//.test(p) && !/\/lote\/\d+/.test(p)) pageQueue.push(`${p}${target.search}`);
          else if (/\/eventos\/leilao\/.+\/lote\/\d+/.test(p) || /\/oferta\/leilao\//.test(p)) candidateUrls.add(target.href);
          else if (/^\/leiloes\/\d+/.test(p)) pageQueue.push(`${p}${target.search}`);
          else if (/page=\d+/.test(target.search) && /\/eventos\/leilao\/|^\/leiloes\/\d+/.test(p)) pageQueue.push(`${p}${target.search}`);
        });
      }
      await drainLots();
    }
    await drainLots();
    if (pageQueue.length || [...candidateUrls].some((url) => !triedUrls.has(url))) partial = true;
    if (!lots.length) partial = true;
    const note = partial ? 'Coleta parcial: houve falha/página sem contrato, exclusão por treino/filtro ou item fora da taxonomia canônica; catálogo não declarado completo.' : undefined;
    return { lots, fetched, skipped, lastStatus, truncated: partial, note };
  } catch (error) {
    if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
    else attempt?.failure('parser');
    throw error;
  } finally {
    await attempt?.finish({ fetched, skipped, returned: lots.length, truncated: partial || lots.length >= limit });
  }
}

const WEB_HOST = 'webleiloes.com.br';
const normalizeHost = (host: string) => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

const dataUtcWeb = (value: string): Date | null => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, d, month, year, hour, minute] = m;
  const time = Date.parse(`${year}-${month}-${d}T${hour}:${minute}:00-03:00`);
  return Number.isFinite(time) ? new Date(time) : null;
};

function propertyTypeWeb(category: string): CanonicalLot['propertyType'] {
  const value = category.toLowerCase();
  if (/apartamento/.test(value)) return 'apartamento';
  if (/casa/.test(value)) return 'casa';
  if (/terreno|gleba/.test(value)) return 'terreno';
  if (/rural|fazenda|s[ií]tio|ch[aá]cara/.test(value)) return 'rural';
  if (/comercial|galp[aã]o|pr[eé]dio|sala/.test(value)) return 'comercial';
  if (/vaga/.test(value)) return 'vaga';
  return 'outro';
}

/** WebLeilões' Yii product detail contract, separate from Suporte Leilões v1. */
export function parseWebLote(html: string, pageUrl: string): CanonicalLot | null {
  const $ = cheerio.load(html);
  let product: any;
  for (const node of $('script[type="application/ld+json"]').toArray()) {
    try {
      const parsed = JSON.parse($(node).contents().text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      product = candidates.find((item) => item?.['@type'] === 'Product');
      if (product) break;
    } catch { /* unrelated or malformed JSON-LD */ }
  }
  if (!product || typeof product.sku !== 'string' || !/^\d+$/.test(product.sku) || typeof product.name !== 'string') return null;
  const page = new URL(pageUrl);
  const itemUrl = new URL(String(product.url ?? pageUrl), pageUrl);
  if (!['http:', 'https:'].includes(itemUrl.protocol) || normalizeHost(itemUrl.hostname) !== WEB_HOST) return null;
  const category = String(product.category ?? '').replace(/\s*>\s*/g, ' / ').trim();
  const classification = classifyAsset(product.name, category);
  if (classification.assetType !== 'imovel') return null;
  const statusText = $('.card-status').first().text().trim().toLowerCase();
  const status: LotStatus = /aberto|lances/.test(statusText) ? 'aberto'
    : /vendid|arrematad/.test(statusText) ? 'vendido'
      : /encerrad|suspens|cancelad/.test(statusText) ? 'encerrado' : 'sem_data';
  const activeInstance = $('.instance-row.active').first();
  const instance = activeInstance.length ? activeInstance : $('.instance-row').last();
  const endUtc = dataUtcWeb(instance.find('.instance-row-date').text());
  const minBid = num(instance.find('.instance-row-value').text());
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const appraisalMatch = /Valor de avalia[cç][ãa]o\s*R\$\s*([\d.]+,\d{2})/i.exec(bodyText);
  const appraisal = appraisalMatch ? num(appraisalMatch[1]) : null;
  const images = Array.isArray(product.image) ? product.image : product.image ? [product.image] : [];
  const imagesSafe = images.filter((x: unknown): x is string => typeof x === 'string' && /^https?:\/\//i.test(x));
  const local = product.offers?.availableAtOrFrom?.address;
  return {
    sourceId: 'suporteleiloes', externalId: product.sku, lotUrl: itemUrl.href,
    titleRaw: product.name, sourceCategory: category, assetType: 'imovel',
    propertyType: propertyTypeWeb(category), closingModel: 'pregao_em_horario',
    auctionStartUtc: null, auctionEndUtc: endUtc, sourceTz: 'America/Sao_Paulo', status,
    currentBid: null, minBid,
    appraisal, auctioneerName: 'WebLeilões', sellerType: classifySeller(null) as any,
    city: typeof local?.addressLocality === 'string' ? local.addressLocality : null,
    state: typeof local?.addressRegion === 'string' ? local.addressRegion : null,
    photos: imagesSafe, raw: { tenant: WEB_HOST, productSku: product.sku, category },
  };
}

export async function collectWebLeiloes(host: string, limit: number, observer?: import('../core/tenant-attempts.js').TenantObserver,
  request: typeof fetchTenantText = fetchTenantText, assetTypes?: string[]): Promise<CollectResult> {
  const normalized = normalizeHost(host);
  if (normalized !== WEB_HOST) throw new Error(`tenant WebLeilões inválido: ${host}`);
  // ponytail: fail closed until Oracle resolves the 68 existing Web SKU collisions with LeilãoBrasil; source URLs/raw are not identity evidence.
  return { lots: [], fetched: 0, skipped: 0, note: 'WebLeilões bloqueado: identidade dos 68 SKUs sobrescritos ainda não reconciliada; coleta/persistência suspensa.' };
}

/** A assinatura que separa tenant genuíno de falso positivo da descoberta. */
function ehSuporteLeiloes(html: string): boolean {
  return /static\.suporteleiloes\.com\.br|suporteleiloes/i.test(html);
}

/**
 * Dados do LEILÃO (evento), lidos de um lote qualquer dele.
 *
 * A data não existe no card nem no lote: `dataFechamento` e `cronometro` do
 * lote vêm null em toda a amostra. Quem carrega o prazo é o evento, em
 * `leilao.data{1,2,3}` com `leilao.praca` dizendo qual vale agora.
 *
 * Sem isso, todo lote desta fonte entrava sem data nenhuma — 1.540 lotes que
 * nenhuma regra de encerramento alcançava, nem o relógio nem a verificação.
 */
interface DadosDoLeilao {
  fim: Date | null;
  leiloeiro: string | null;
  codigo: string | null;
  photos: string[];
}

/** O slug do leilão na URL do lote é a chave do evento: /eventos/leilao/{slug}/lote/{id}/... */
const slugDoLeilao = (url: string): string | null => /\/eventos\/leilao\/([^/]+)\/lote\//.exec(url)?.[1] ?? null;

function dataDoBloco(v: any): Date | null {
  // O formato é {date, timezone_type, timezone} do PHP, em America/Fortaleza —
  // mesmo UTC-3 de Brasília e sem horário de verão.
  const bruto = typeof v === 'string' ? v : v?.date;
  if (!bruto) return null;
  const t = Date.parse(`${String(bruto).replace(' ', 'T').slice(0, 19)}-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function lerLeilao(urlDeUmLote: string, attempt?: TenantAttempt): Promise<DadosDoLeilao | null> {
  let r;
  try {
    r = await fetchText(urlDeUmLote, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 30000 });
  } catch (error) {
    if (error instanceof CollectionCancellationError) throw error;
    attempt?.failure('network');
    return null;
  }
  attempt?.response(r.status);
  if (r.status !== 200) return null;
  // `var lote = {...};` — JSON válido, produzido por json_encode do PHP.
  const m = /var\s+lote\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(r.body);
  if (!m) return null;
  let lote: any;
  try {
    lote = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const le = lote?.leilao;
  if (!le) return null;
  const praca = Number(le.praca ?? 1);
  const photos: string[] = [];
  try {
    let arquivos = lote?.bem?.arquivos ?? lote?.item?.arquivos ?? lote?.bemItem?.arquivos;
    if (!Array.isArray(arquivos)) {
      // fallback: search in JSON recursively small
      const str = JSON.stringify(lote);
      const m = str.match(/"arquivos":(\[[^\]]*\])/g);
      if (m) {
        for (const g of m) {
          try {
            const arr = JSON.parse(g.slice(g.indexOf('[')));
            arquivos = arquivos || [];
            for (const x of arr) arquivos.push(x);
          } catch {}
        }
      }
    }
    if (Array.isArray(arquivos)) {
      for (const a of arquivos) {
        const url = a?.url || a?.full?.url || a?.versions?.full?.url || a?.versions?.min?.url || a?.versions?.thumb?.url || a?.arquivo?.url;
        if (url && /arquivos\//.test(String(url))) {
          const u = String(url);
          if (!photos.includes(u)) photos.push(u);
          if (photos.length >= 20) break;
        }
      }
    }
  } catch {}
  return {
    fim: dataDoBloco(le[`data${praca >= 3 ? 3 : praca === 2 ? 2 : 1}`]) ?? dataDoBloco(le.data1),
    // A fonte publica "Leiloeiro Oficial Exemplo" em leilão de teste; nome
    // falso na faceta é pior que faceta vazia.
    leiloeiro: campos.nomeDeLeiloeiro(le.leiloeiro?.nome),
    codigo: le.codigo ? String(le.codigo) : null,
    photos,
  };
}

const STATUS: Record<string, LotStatus> = { '1': 'aberto' };
const statusDoCard = (classe: string): LotStatus => {
  const m = /status-(\d+)/.exec(classe);
  // Só o código 1 foi observado como aberto; não inferir os demais.
  return (m && STATUS[m[1]]) ?? 'sem_data';
};

interface Card {
  id: string;
  url: string;
  titulo: string;
  categoria: string | null;
  foto: string | null;
  status: LotStatus;
  statusBruto: string | null;
  minBid: number | null;
  currentBid: number | null;
  city: string | null;
  state: string | null;
}

/**
 * Cards da listagem.
 *
 * O container `div.lote-main` carrega o id e o status nas próprias classes
 * (`bem-index-{id}` e `lote-main-status-{n}`), o que evita depender da ordem
 * dos elementos internos.
 *
 * Duas armadilhas medidas na marcação:
 *  - o `<h3>` é a CATEGORIA ("Ambulância"), não o título; o título está no
 *    primeiro `<p>` de `.reset-grid` ("FIAT / DOBLO GREENCAR MO4 2016 / 2016").
 *    Pegar "o primeiro `<p>` do card" traz um aviso comercial ("Sem Prazo Para
 *    Desvinculação"), que foi o que a primeira versão gravou como título.
 *  - "Lance Atual" vem com o texto "-" quando não há lance; sem tratar, vira 0.
 */
function lerCards(html: string, host: string): Card[] {
  const $ = cheerio.load(html);
  const cards: Card[] = [];

  $('.lote-main').each((_, el) => {
    const bloco = $(el);
    const classe = bloco.attr('class') ?? '';
    const href = bloco.find('a[href*="/lote/"]').first().attr('href') ?? '';
    const id = /bem-index-(\d+)/.exec(classe)?.[1] ?? /\/lote\/(\d+)/.exec(href)?.[1];
    if (!id || !href || cards.some((c) => c.id === id)) return;

    const grid = bloco.find('.reset-grid').first();
    const titulo = grid.find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!titulo) return;

    // "Barão de Cocais - MG" — a spec dizia que não havia local no card; há.
    const local = bloco.find('.r2 span').first().text().trim();
    const mLocal = /^(.+?)\s*-\s*([A-Z]{2})$/.exec(local);

    const foto = bloco.find('img.img-evento, a.link-img img').first().attr('src') ?? null;
    const statusBruto = /lote-main-status-(\d+)/.exec(classe)?.[1] ?? null;

    cards.push({
      id,
      url: href.startsWith('http') ? href : `https://${host}${href.startsWith('/') ? '' : '/'}${href}`,
      titulo,
      categoria: grid.find('h3').first().text().trim() || null,
      foto: foto && /\/bens\//.test(foto) ? foto : null,
      status: statusDoCard(classe),
      statusBruto,
      minBid: num(bloco.find('.r4 strong.reset-colorGrid').first().text()),
      currentBid: num(bloco.find('.r4 strong.valor-grid').first().text()),
      city: mLocal ? mLocal[1].trim() : null,
      state: mLocal ? mLocal[2] : null,
    });
  });
  return cards;
}

/** Última página, pelo link de paginação. Sem o marcador, é página única. */
function ultimaPagina(html: string): number {
  const $ = cheerio.load(html);
  let max = 1;
  $('a[href*="page="]').each((_, a) => {
    const n = Number(/page=(\d+)/.exec($(a).attr('href') ?? '')?.[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

function mapCard(c: Card, asset: AssetType, host: string, ev: DadosDoLeilao | null): CanonicalLot {
  return {
    sourceId: 'suporteleiloes',
    // O id é GLOBAL nesta plataforma (medido: o mesmo id resolve para o mesmo
    // lote em tenants diferentes, e id de outro tenant dá 404 limpo, nunca um
    // lote trocado). Sem prefixo de host, ao contrário do soleon — e o overlap
    // entre tenants é resolvido de graça pela chave única.
    externalId: c.id,
    lotUrl: c.url,
    titleRaw: c.titulo,
    sourceCategory: c.categoria,
    assetType: asset,
    // A data mora no LEILÃO, não no lote: `dataFechamento` e `cronometro` do
    // lote vieram null em toda a amostra, nas duas arquiteturas.
    closingModel: 'pregao_em_horario',
    // O prazo vem do EVENTO, não do lote — ver lerLeilao().
    auctionEndUtc: ev?.fim ?? null,
    auctionStartUtc: null,
    sourceTz: 'America/Sao_Paulo',
    status: c.status,
    auctioneerName: ev?.leiloeiro ?? null,
    currentBid: c.currentBid,
    minBid: c.minBid,
    // Metade dos lotes não traz o rótulo de local; o título e a URL trazem
    // ("Vacaria/Rio Grande do Sul: Terreno…").
    // O card às vezes traz o comitente no lugar do local ("Prefeitura
    // Municipal de Verdelandia") — o aparador tira o rótulo e sobra a cidade.
    city: campos.apararCidade(c.city ?? '') || campos.localDeTexto(c.titulo)?.city || campos.localDeTexto(c.url)?.city || null,
    state: c.state ?? campos.localDeTexto(c.titulo)?.uf ?? campos.localDeTexto(c.url)?.uf ?? null,
    photos: Array.from(new Set([...(c.foto ? [c.foto] : []), ...(ev?.photos ?? [])])),
    photoCount: Array.from(new Set([...(c.foto ? [c.foto] : []), ...(ev?.photos ?? [])])).length,
    raw: { tenant: host, statusCard: c.statusBruto, leilao: ev?.codigo ?? null },
  } as CanonicalLot;
}

export const suporteleiloes: Connector = {
  def: {
    id: 'suporteleiloes',
    name: 'Suporte Leilões',
    platform: 'suporte-leiloes',
    method: 'json-embedded',
    tier: 2,
    siteUrl: 'https://www.liderleiloes.com.br',
    notes:
      'White-label multi-tenant, duas gerações de front (v1 Laravel implementada, v2 Next.js pendente). A coluna platform tem falso positivo: superbid.net. Validar assinatura antes de coletar.',
  },

  async collect({ limit, assetTypes, observer, tenant }, request: typeof fetchText = fetchText): Promise<CollectResult> {
    if (tenant && normalizeHost(tenant) === WEB_HOST) {
      throw new Error('WebLeilões bloqueado: identidade dos 68 SKUs sobrescritos ainda não reconciliada; coleta/persistência suspensa.');
    }
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const notes: string[] = [];

    for (const host of await eligibleTenants(Number(process.env.SUPORTELEILOES_TENANTS ?? 60), tenant)) {
      if (lots.length >= limit) break;
      const normalized = normalizeHost(host);
      const lookupExisting = async (lotUrl: string, proposedId: string) => {
        const rows = await query<{ external_id: string; same_url: boolean }>(`SELECT external_id,
            lower(regexp_replace(lot_url, '^https?://(www\\.)?', '')) =
            lower(regexp_replace($2, '^https?://(www\\.)?', '')) AS same_url
          FROM lots WHERE source_id=$1 AND (
            lower(regexp_replace(lot_url, '^https?://(www\\.)?', '')) =
              lower(regexp_replace($2, '^https?://(www\\.)?', '')) OR external_id=$3
          ) ORDER BY same_url DESC, id LIMIT 1`, ['suporteleiloes', lotUrl, proposedId]);
        if (!rows.length) return null;
        return rows[0].same_url ? rows[0].external_id : { collision: true as const };
      };
      const result = normalized === WEB_HOST
        ? await collectWebLeiloes(host, limit - lots.length, observer, fetchTenantText, assetTypes)
          : FOLLOWUP_TENANTS.has(normalized)
          ? await collectDiscoveredTenant(host, limit - lots.length, assetTypes, observer, request, lookupExisting)
          : await collectSuporteTenant(host, limit - lots.length, assetTypes, observer, request);
      lots.push(...result.lots);
      fetched += result.fetched;
      skipped += result.skipped;
      status = (result as any).httpStatus || (result as any).lastStatus || status;
      const resultNote = (result as typeof result & { note?: string }).note;
      if (resultNote) notes.push(`${normalized}: ${resultNote}`);
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status, note: notes.length ? notes.join(' ') : undefined };
  },
};
