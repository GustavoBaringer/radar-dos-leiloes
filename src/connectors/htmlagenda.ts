import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import { classifyAsset, classifySeller, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const PAGINAS = ['/', '/agenda-de-leiloes', '/agenda', '/Agenda.aspx', '/eventos/proximos', '/evento.php', '/leilao', '/lotes-encerrando', '/lotes', '/lotes/imoveis', '/lotes/veiculos'];
const ESCOPO = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|sala|loja|fazenda|rural|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento|sucata/i;
const ESCOPO_ASP = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|fazenda|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento/i;
const FORA_ESCOPO = /numism[aá]tica|filatelia|cart[õo]es?\s+postais|eucalol|brinquedos?|colecion[aá]veis|porcelana|moedas?/i;
const MONITORED_ONLY = ['coliseumleiloes.com.br', 'leiloesbrasilpe.com.br', 'albuquerqueleiloes.com.br', 'ghvmleiloes.com.br', 'portaldosleiloes.com.br'];
const REVIEWED_CATALOG_PATHS: Record<string, string[]> = {
  'marcoantonioleiloeiro.com.br': ['/leiloes/judiciais', '/leiloes/extrajudiciais'],
  'dcmleiloes.com.br': ['/leiloes/judiciais', '/leiloes/extrajudiciais'],
};
const MJ_TENANT = 'mjleiloes.com.br';
const REVIEWED_TENANTS = ['c3leiloes.com.br', 'leiloescostaesilva.com.br', 'tbaracajuleiloes.com.br', ...MONITORED_ONLY, ...Object.keys(REVIEWED_CATALOG_PATHS), MJ_TENANT];
// Fases precisas, não a palavra solta: quase toda página que usa reCAPTCHA
// carrega "grecaptcha" num <script>, e testar o HTML inteiro marcava catálogo
// como bloqueado. O texto visível é o que diz se o servidor pediu desafio.
const BLOCKED = /sistema indispon[ií]vel|acesso negado|access denied|radware bot manager|just a moment|checking your browser|complete (?:o|the) captcha|verifica[cç][aã]o de seguran[cç]a/i;

export function isBlockedPage(body: string): boolean {
  const $ = cheerio.load(body);
  $('script,style,noscript').remove();
  return BLOCKED.test($.root().text());
}

export function isAspCatalogInScope(text: string): boolean {
  return ESCOPO_ASP.test(text) && !FORA_ESCOPO.test(text);
}

export function isAspLotEligible(title: string): boolean {
  return Boolean(title.trim()) && !looksLikePart(title) && !looksLikeCollectible(title) && ESCOPO.test(title) && !FORA_ESCOPO.test(title);
}

export function reviewedTenant(tenant: string): string {
  const found = filterTenantPopulation(REVIEWED_TENANTS, tenant);
  if (!found.length) throw new Error(`single-tenant '${tenant}' fora da população revisada de htmlagenda`);
  return found[0];
}

export function selectTenantPopulation(domains: readonly string[], tenant: string): string[] {
  if (!tenant.trim()) throw new Error('single-tenant htmlagenda inválido');
  const reviewed = filterTenantPopulation(REVIEWED_TENANTS, tenant);
  if (reviewed.length) return reviewed;
  const selected = filterTenantPopulation(domains, tenant);
  if (!selected.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de htmlagenda`);
  return selected;
}

export function blockedPageError(status = 200): Error {
  return Object.assign(new Error(`HTMLAGENDA: bloqueio/aplicação indisponível (HTTP ${status} com conteúdo de bloqueio)`), { httpStatus: status });
}

export function aspItemIds(html: string): string[] {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $('a[href]').each((_, a) => {
    const id = ($(a).attr('href') ?? '').match(/peca\.asp\?[^#]*\bID=(\d+)/i)?.[1];
    if (id) ids.add(id);
  });
  return [...ids];
}

export function reviewedCatalogLotLinks(html: string, base: string): string[] {
  const $ = cheerio.load(html), host = new URL(base).hostname.toLowerCase();
  const links = new Set<string>();
  $('a[href]').each((_, a) => {
    try {
      const url = new URL($(a).attr('href') ?? '', base);
      if (url.hostname.toLowerCase() === host && /^\/lotes\/\d+\/?$/.test(url.pathname)) links.add(url.href);
    } catch { /* ignore malformed links */ }
  });
  return [...links];
}

function aspLastPage(html: string): number {
  return Math.max(1, ...[...html.matchAll(/[?&]pag=(\d+)/gi)].map((match) => Number(match[1])).filter(Number.isSafeInteger));
}

async function tenants(limite: number, tenant?: string): Promise<string[]> {
  if (tenant !== undefined && !tenant.trim()) throw new Error('single-tenant htmlagenda inválido');
  const explicitos = String(process.env.HTMLAGENDA_DOMAINS ?? '').trim();
  if (explicitos) {
    const lista = explicitos.split(',').map((d) => d.trim()).filter(Boolean);
    if (!tenant) return lista;
    return selectTenantPopulation(lista, tenant);
  }
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='html-agenda' AND http_status=200 AND has_lots IS NOT FALSE
       ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  const population = rows.map((r) => r.domain);
  if (tenant !== undefined) return selectTenantPopulation(population, tenant);
  const escolhidos = await dueTenants({ sourceId: 'htmlagenda', candidates: population, limit: limite, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  return escolhidos;
}

function texto(s?: string | null): string {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluta(base: string, href: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function slugTitulo(url: string): string {
  const last = decodeURIComponent(url.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ');
  return last.replace(/\b\d{3,}\b/g, '').replace(/\s+/g, ' ').trim();
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function linksDePagina(base: string, path: string, observer?: import('../core/tenant-attempts.js').TenantAttempt): Promise<{ status: number; links: string[]; body: string }> {
  let r;
  try {
    r = await fetchText(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 900 });
  } catch (error) {
    // Cancelamento não é falha de rede daquele tenant: o catch externo classifica.
    if (error instanceof CollectionCancellationError) throw error;
    observer?.failure('network');
    throw error;
  }
  if (r.status !== 200) { if (path === '/') observer?.response(r.status); return { status: r.status, links: [], body: r.body }; }
  if (path === '/') {
    if (isBlockedPage(r.body)) {
      observer?.response(r.status);
      observer?.failure('parser');
      return { status: r.status, links: [], body: r.body };
    }
    observer?.response(r.status);
  }
  const $ = cheerio.load(r.body);
  const links = new Set<string>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (!/(\/(lote|lotes|leilao|leiloes|eventos\/leilao)\/|evento\.php|agenda\.aspx)/i.test(href)) return;
    const u = absoluta(base, href);
    if (u) links.add(u);
  });
  return { status: r.status, links: [...links], body: r.body };
}

async function aspCatalog(base: string, body: string, attempt?: import('../core/tenant-attempts.js').TenantAttempt, remaining = Number.MAX_SAFE_INTEGER): Promise<{ lots: CanonicalLot[]; fetched: number; skipped: number; httpStatus: number; truncated: boolean }> {
  const allEvents = [...new Set([...body.matchAll(/catalogo\.asp\?Num=(\d+)/gi)].map((m) => m[1]))];
  const events = allEvents.slice(0, 4);
  const lots: CanonicalLot[] = [];
  const seen = new Set<string>();
  let fetched = 0, skipped = 0, httpStatus = 0;
  let truncated = allEvents.length > events.length;
  for (const num of events) {
    throwIfCancelled();
    const first = await fetchText(`${base}/catalogo.asp?Num=${num}`, { headers: { 'user-agent': UA }, gapMs: 900 });
    httpStatus = first.status;
    attempt?.response(first.status);
    if (first.status !== 200) continue;
    const title = cheerio.load(first.body)('meta[property="og:title"]').attr('content') ?? cheerio.load(first.body)('title').text();
    const evidence = `${title} ${cheerio.load(first.body)('h1').text()}`;
    // Accessible but clearly collectible catalogs are counted as observed and rejected without item/detail fan-out.
    if (!isAspCatalogInScope(evidence)) {
      if (FORA_ESCOPO.test(evidence)) {
        const ids = aspItemIds(first.body);
        fetched += ids.length;
        skipped += ids.length;
        if (aspLastPage(first.body) > 1) truncated = true;
      }
      continue;
    }
    const pages = [first.body];
    const lastPage = aspLastPage(first.body);
    if (lastPage > 3) truncated = true;
    for (let page = 2; page <= Math.min(lastPage, 3); page++) {
      throwIfCancelled();
      const r = await fetchText(`${base}/catalogo.asp?Num=${num}&pag=${page}`, { headers: { 'user-agent': UA }, gapMs: 900 });
      if (r.status !== 200) { truncated = true; break; }
      pages.push(r.body);
      if (page === 3 && aspLastPage(r.body) > 3) truncated = true;
    }
    for (const html of pages) {
      const $ = cheerio.load(html);
      for (const id of aspItemIds(html)) {
        if (seen.has(id)) continue;
        seen.add(id);
        fetched++;
        const title = texto($('a[href]').filter((_, a) => ($(a).attr('href') ?? '').match(/peca\.asp\?[^#]*\bID=(\d+)/i)?.[1] === id).first().text());
        if (!isAspLotEligible(title)) { skipped++; continue; }
        if (lots.length >= remaining) { truncated = true; continue; }
        const parsed = parseTitle(title), cls = classifyAsset(title), local = campos.localDeTexto(title);
        // Keep ASP mapping deliberately conservative; title evidence only, no fabricated lot details.
        lots.push({
          sourceId: 'htmlagenda', externalId: `${new URL(base).hostname}:${id}`, lotUrl: `${base}/peca.asp?ID=${id}`, titleRaw: title,
          brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
          assetType: cls.assetType, vehicleType: cls.vehicleType, closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: 'sem_data',
          minBid: null, currentBid: null, auctioneerName: new URL(base).hostname, sellerType: classifySeller(null) as any,
          city: local?.city ?? null, state: local?.uf ?? null, photos: [], raw: { tenant: new URL(base).hostname, generic: true, asp: true },
        });
      }
    }
  }
  return { lots, fetched, skipped, httpStatus, truncated };
}

function jsonObjectAt(text: string, start: number): Record<string, any> | null {
  if (start < 0 || text[start] !== '{') return null;
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && text[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function jsonObjectAfter(text: string, key: string): Record<string, any> | null {
  const matches = new RegExp(`\\"${key}\\"\\s*:`, 'g');
  let result: Record<string, any> | null = null, match: RegExpExecArray | null;
  while ((match = matches.exec(text))) result = jsonObjectAt(text, text.indexOf('{', match.index + match[0].length)) ?? result;
  return result;
}

function jsonObjectAssignment(text: string, variable: string): Record<string, any> | null {
  const marker = new RegExp(`\\bvar\\s+${variable}\\s*=\\s*\\{`, 'g');
  let result: Record<string, any> | null = null, match: RegExpExecArray | null;
  while ((match = marker.exec(text))) result = jsonObjectAt(text, match.index + match[0].lastIndexOf('{')) ?? result;
  return result;
}

function payloadDaPagina(html: string): Record<string, any> | null {
  const $ = cheerio.load(html);
  let flight = '';
  $('script').each((_, el) => {
    const script = $(el).html() ?? '';
    const at = script.indexOf('self.__next_f.push(');
    if (at < 0) return;
    try {
      const arg = JSON.parse(script.slice(script.indexOf('(', at) + 1, script.lastIndexOf(')')));
      if (Array.isArray(arg) && typeof arg[1] === 'string') flight += arg[1];
    } catch { /* ignore unrelated or incomplete Next flight chunks */ }
  });
  return jsonObjectAfter(flight, 'initialLote') ?? jsonObjectAssignment(html, 'lote') ?? jsonObjectAfter(html, 'initialLote');
}

export function mapHtmlAgendaLot(host: string, url: string, html: string, status = 200): CanonicalLot | null {
  const $ = cheerio.load(html);
  const h1 = texto($('h1').first().text() || $('title').first().text());
  const reviewedProbe = REVIEWED_TENANTS.includes(host.replace(/^www\./i, '').toLowerCase());
  if (reviewedProbe && status !== 200) return null;
  const titulo = h1 && !/^(início|home)$/i.test(h1) ? h1 : reviewedProbe ? '' : slugTitulo(url);
  const body = texto(html).slice(0, 6000);
  const pathId = url.match(/\/(?:lote|lotes)\/(\d+)/i)?.[1];
  const isMj = host.replace(/^www\./i, '').toLowerCase() === MJ_TENANT;
  const lotPayload = payloadDaPagina(html);
  const mjEvent = host.replace(/^www\./i, '').toLowerCase() === MJ_TENANT ? jsonObjectAssignment(html, 'leilao') : null;
  const linkedPayload = Boolean(pathId && String(lotPayload?.id) === pathId);
  if (isMj && !linkedPayload) return null;
  const tipoPai = linkedPayload ? String(lotPayload?.bem?.tipoPai ?? '') : '';
  const category = /Im[oó]veis?/i.test(tipoPai) ? 'imovel' : /Ve[ií]culos?/i.test(tipoPai) ? 'veiculo' : null;
  const parsed = parseTitle(titulo);
  const cls = classifyAsset(titulo, category);
  const scopeText = reviewedProbe ? `${titulo} ${category ?? ''}` : `${titulo} ${body}`;
  if (!titulo || (isMj && /\bsucata\b/i.test(titulo)) || looksLikePart(titulo) || looksLikeCollectible(titulo) ||
      (isMj ? cls.assetType === 'outro' : !ESCOPO.test(scopeText)) || (reviewedProbe && cls.assetType === 'outro')) return null;
  const local = campos.localDeTexto(`${titulo} ${body}`);
  const payloadNumber = (key: 'lanceInicial' | 'valorInicial' | 'valorAvaliado') => {
    const value = lotPayload?.[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const valorRotulado = (label: string) => dinheiro(body.match(new RegExp(`(?:${label})[\\s.,:;()\\-]*(R\\$\\s*[\\d.,]+)`, 'i'))?.[1]);
  const valorAntesDoRotulo = (label: string) => dinheiro(body.match(new RegExp(`(R\\$\\s*[\\d.,]+)[\\s.,:;()\\-]*(?:${label})`, 'i'))?.[1]);
  const minBid = linkedPayload ? payloadNumber('lanceInicial') : host.replace(/^www\./i, '').toLowerCase() === MJ_TENANT ? payloadNumber('valorInicial') : null;
  const verifiedMinBid = minBid ?? valorRotulado('\\blance\\s+(?:inicial|mínimo|minimo)\\b') ?? valorAntesDoRotulo('\\blance\\s+(?:inicial|mínimo|minimo)\\b');
  const currentBid = valorRotulado('\\blance\\s+(?:atual|maior)\\b') ?? valorRotulado('\\bmaior\\s+lance\\b') ?? valorAntesDoRotulo('\\blance\\s+(?:atual|maior)\\b|\\bmaior\\s+lance\\b');
  const avaliacaoFonte = linkedPayload ? payloadNumber('valorAvaliado') : null;
  const phpDate = (value: any): Date | null => {
    const raw = typeof value === 'string' ? value : value?.date;
    if (!raw) return null;
    const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${String(raw).replace(' ', 'T').slice(0, 19)}-03:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const lotStatus = isMj && /aberto para lances/i.test(body) ? 'aberto'
    : isMj && /leil[aã]o encerrado|lote encerrado/i.test(body) ? 'encerrado' : 'sem_data';
  const id = `${host}:${url.match(/\/(?:lote|lotes|leilao)\/([^/?#]+)/i)?.[1] ?? url.match(/(?:id|cod|evento)=([^&#]+)/i)?.[1] ?? url}`;
  return {
    sourceId: 'htmlagenda', externalId: id, lotUrl: url, titleRaw: titulo,
    brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
    sourceCategory: category, assetType: cls.assetType, vehicleType: cls.vehicleType,
    closingModel: 'timer_por_lote', sourceTz: isMj ? 'America/Fortaleza' : 'America/Sao_Paulo', status: lotStatus,
    auctionStartUtc: isMj ? phpDate(mjEvent?.dataPraca1) : null,
    auctionEndUtc: isMj ? phpDate(mjEvent?.dataFimPraca1) : null,
    minBid: verifiedMinBid, currentBid, appraisal: avaliacaoFonte, auctioneerName: host.replace(/^www\./, ''), sellerType: classifySeller(null) as any,
    city: local?.city ?? null, state: local?.uf ?? null, photos: [], raw: { tenant: host, generic: true },
  };
}

async function loteDeUrl(host: string, url: string, observer?: import('../core/tenant-attempts.js').TenantAttempt): Promise<CanonicalLot | null> {
  let html = '';
  let status = 0;
  try {
    const r = await fetchText(url, { headers: { 'user-agent': UA }, gapMs: 900 });
    status = r.status;
    observer?.response(r.status);
    if (r.status === 200) html = r.body;
  } catch (error) {
    if (error instanceof CollectionCancellationError) throw error;
    observer?.failure('network'); /* usa slug */
  }
  return mapHtmlAgendaLot(host, url, html, status);
}

type HtmlAgendaFetch = typeof fetchText;

function mjEventLinks(html: string, base: string): Array<{ url: string; text: string }> {
  const $ = cheerio.load(html), hostname = new URL(base).hostname.replace(/^www\./i, '').toLowerCase(), links = new Map<string, string>();
  $('a[href]').each((_, el) => {
    try {
      const url = new URL($(el).attr('href') ?? '', base);
      if (url.hostname.replace(/^www\./i, '').toLowerCase() !== hostname || !/^\/leiloes\/\d+\/?$/.test(url.pathname)) return;
      links.set(url.href, texto($(el).closest('article').text() || $(el).parent().text()));
    } catch { /* ignore malformed or external event links */ }
  });
  return [...links].map(([url, text]) => ({ url, text }));
}

function mjLotCards(html: string, base: string): Array<{ url: string; title: string; id: string }> {
  const $ = cheerio.load(html), hostname = new URL(base).hostname.replace(/^www\./i, '').toLowerCase(), cards = new Map<string, { url: string; title: string; id: string }>();
  $('.lote').each((_, el) => {
    const card = $(el), a = card.find('a[href^="/lote/"]').toArray().find((item) => $(item).text().trim().length > 8);
    if (!a) return;
    try {
      const url = new URL($(a).attr('href') ?? '', base), id = url.pathname.match(/^\/lote\/(\d+)\//)?.[1];
      if (url.hostname.replace(/^www\./i, '').toLowerCase() !== hostname || !id) return;
      url.hash = '';
      if (!cards.has(id)) cards.set(id, { url: url.href, id, title: texto($(a).text()) });
    } catch { /* ignore malformed or external lot links */ }
  });
  return [...cards.values()];
}

function mjTitleEligible(title: string): boolean {
  return Boolean(title.trim()) && !/\bsucata\b|inform[aá]tica|notebook|computador|servidor|impressora/i.test(title) &&
    !looksLikePart(title) && !looksLikeCollectible(title) && !FORA_ESCOPO.test(title) && classifyAsset(title).assetType !== 'outro';
}

export async function collectMjLeiloes(host: string, limit: number, observer?: import('../core/tenant-attempts.js').TenantAttempt, fetcher: HtmlAgendaFetch = fetchText): Promise<CollectResult> {
  const base = `https://${host}`, reasons = new Set<string>(), candidates = new Map<string, { url: string; title: string }>();
  let httpStatus = 0, skipped = 0;
  const get = async (url: string): Promise<string | null> => {
    throwIfCancelled();
    try {
      const response = await fetcher(url, { headers: { 'user-agent': UA }, gapMs: 900, timeoutMs: 30000 });
      observer?.response(response.status);
      httpStatus = response.status || httpStatus;
      if (response.status !== 200) { reasons.add(`${url}: HTTP ${response.status}`); return null; }
      return response.body;
    } catch (error) {
      if (error instanceof CollectionCancellationError) throw error;
      observer?.failure('network');
      reasons.add(`${url}: falha de rede`);
      return null;
    }
  };
  const home = await get(`${base}/leiloes`);
  if (!home) return { lots: [], fetched: 0, skipped: 0, httpStatus, note: [...reasons].join('; ') || 'catálogo MJ indisponível' };
  for (const event of mjEventLinks(home, base)) {
    throwIfCancelled();
    if (/em loteamento/i.test(event.text)) continue;
    const pages = [event.url], seen = new Set<string>(), signatures = new Set<string>();
    while (pages.length) {
      throwIfCancelled();
      const pageUrl = pages.shift()!;
      if (seen.has(pageUrl)) continue;
      seen.add(pageUrl);
      const html = await get(pageUrl);
      if (!html) continue;
      const found = mjLotCards(html, base), signature = found.map((card) => card.id).join(',');
      if (signature && !signatures.has(signature)) {
        signatures.add(signature);
        for (const card of found) if (!candidates.has(card.url)) candidates.set(card.url, card);
      }
      const $ = cheerio.load(html), current = new URL(pageUrl);
      $('a[href*="page="]').each((_, el) => {
        try {
          const next = new URL($(el).attr('href') ?? '', current);
      if (next.hostname.replace(/^www\./i, '').toLowerCase() === current.hostname.replace(/^www\./i, '').toLowerCase() && next.pathname === current.pathname && next.searchParams.has('page') && !seen.has(next.href) && !pages.includes(next.href)) pages.push(next.href);
        } catch { /* ignore malformed pagination links */ }
      });
    }
  }
  const eligible = [...candidates.values()].filter((card) => mjTitleEligible(card.title));
  skipped += candidates.size - eligible.length;
  if (eligible.length > limit) reasons.add(`limite solicitado (${limit}) atingido; catálogo parcial`);
  const lots: CanonicalLot[] = [];
  for (const card of eligible.slice(0, limit)) {
    throwIfCancelled();
    const html = await get(card.url);
    if (!html) { skipped++; continue; }
    const lot = mapHtmlAgendaLot(host, card.url, html, 200);
    if (lot) lots.push(lot); else skipped++;
  }
  return { lots, fetched: candidates.size, skipped, httpStatus, note: reasons.size ? [...reasons].join('; ') : undefined };
}

/** Domains with useful health signals but no reviewed lot-publication contract. */
export function isMonitorOnlyDomain(domain: string): boolean {
  return MONITORED_ONLY.includes(domain.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase());
}

export async function collectHtmlAgendaMonitor(host: string, attempt: import('../core/tenant-attempts.js').TenantAttempt | undefined, fetcher: HtmlAgendaFetch = fetchText): Promise<CollectResult> {
  let fetched = 0, skipped = 0, httpStatus = 0;
  let failureMarked = false;
  const fail = (kind: 'network' | 'parser' | 'budget') => { failureMarked = true; attempt?.failure(kind); };
  const base = `https://${host}`;
  const get = async (path: string) => {
    let r;
    try { r = await fetcher(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 900 }); }
    catch (error) {
      if (error instanceof CollectionCancellationError) throw error;
      fail('network');
      throw error;
    }
    httpStatus = r.status;
    attempt?.response(r.status);
    if (r.status !== 200) throw new Error(`HTMLAGENDA monitor ${host}: HTTP ${r.status} em ${path}`);
    if (isBlockedPage(r.body)) {
      fail('parser');
      throw blockedPageError(r.status);
    }
    return r.body;
  };
  try {
    if (host === 'albuquerqueleiloes.com.br') await get('/');
    else if (host === 'ghvmleiloes.com.br') {
      const html = await get('/');
      const $ = cheerio.load(html);
      const publicTargets = $('a[href]').toArray().map((a) => $(a).attr('href') ?? '')
        .filter((href) => /leil|lote/i.test(href) && !/rss|feed/i.test(href));
      if (!publicTargets.length) {
        throw new Error('HTMLAGENDA monitor ghvmleiloes.com.br: vínculo de catálogo GHVM não confirmado');
      }
      throw new Error('HTMLAGENDA monitor ghvmleiloes.com.br: contrato de catálogo público pendente de revisão');
    } else if (host === 'portaldosleiloes.com.br') {
      const home = await get('/');
      let body = home;
      // Only the known public listing route is inspected; no lots are ever published for this tenant.
      if (!/lei-?lote|lotes|nenhum lote/i.test(texto(home))) body = `${home} ${await get('/lotes')}`;
      const $ = cheerio.load(body);
      const observed = new Set<string>();
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        if (/lei-?lote|\/lotes?\//i.test(href) && !/demo|modelo|juce000/i.test(`${href} ${$(a).text()}`)) observed.add(href);
      });
      const badges = texto(body).match(/\b\d+\s+(?:lei-?lotes?|lotes?)\b/gi) ?? [];
      fetched = observed.size + badges.length;
      skipped = fetched;
    } else if (host === 'coliseumleiloes.com.br') {
      await get('/');
      const pages = await Promise.all([
        get('/agenda/site/agenda-leiloes.php?tipoLeilao=1'),
        get('/agenda/site/agenda-leiloes.php?tipoLeilao=3'),
      ]);
      for (const body of pages) {
        if (/\/lotes?\//i.test(body) && !/EM\s*LOTEAMENTO\s*\(\s*Aguarde\s+os\s+lotes/i.test(texto(body))) {
          throw new Error('HTMLAGENDA monitor coliseumleiloes.com.br: links de lotes encontrados, contrato pendente de revisão');
        }
        if (!/EM\s*LOTEAMENTO\s*\(\s*Aguarde\s+os\s+lotes|nenhum (?:lote|bem)|sem lotes/i.test(texto(body))) {
          throw new Error('HTMLAGENDA monitor coliseumleiloes.com.br: status público de lotes não reconhecido');
        }
      }
    } else if (host === 'leiloesbrasilpe.com.br') {
      const home = await get('/');
      const $ = cheerio.load(home);
      const href = $('a[href]').toArray().map((a) => $(a).attr('href') ?? '')
        .find((value) => /^\/leilao\/\d+\/?$/i.test(value));
      const paths = [...new Set(['/leiloes', '/leilao/3', ...(href ? [href] : [])])].slice(0, 3);
      const pages = await Promise.all(paths.map(get));
      const combined = texto(pages.join(' '));
      if (!/nenhum bem cadastrado|\bEM\s+BREVE\b/i.test(combined)) {
        throw new Error('HTMLAGENDA monitor leiloesbrasilpe.com.br: catálogo de bens ainda sem contrato confirmado');
      }
    }
    return { lots: [], fetched, skipped, httpStatus, note: 'Monitoramento sem publicação: contrato de lotes não revisado.' };
  } catch (error) {
    if (!failureMarked && error instanceof CollectionCancellationError) fail(error.kind === 'deadline' ? 'budget' : 'network');
    else if (!failureMarked && !/HTTP \d+/.test(error instanceof Error ? error.message : '')) fail('parser');
    throw error;
  } finally {
    await attempt?.finish({ fetched, skipped, returned: 0 });
  }
}

export const htmlagenda: Connector = {
  def: { id: 'htmlagenda', name: 'HTML Agenda Genérico', platform: 'HTML Agenda', method: 'html', tier: 5, siteUrl: 'https://sites-de-leiloeiros', notes: 'Conector conservador para sites server-rendered com links /lote, /lotes, /leilao ou /eventos/leilao; só grava títulos de imóvel/veículo/máquina/equipamento.' },
  async collect({ limit, observer, tenant }): Promise<CollectResult> {
    throwIfCancelled();
    const lots: CanonicalLot[] = [];
    const notes: string[] = [];
    let fetched = 0, skipped = 0, httpStatus = 0;
    const dominios = await tenants(Number(process.env.HTMLAGENDA_TENANTS ?? 30), tenant);
    for (const host of dominios) {
      if (lots.length >= limit) break;
      throwIfCancelled();
      const attempt = await observer?.start(host);
      const antes = lots.length, fetchedAntes = fetched, skippedAntes = skipped;
      let truncated = false;
      let monitorAttemptFinished = false;
      try {
      const normalizedHost = host.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase();
      if (normalizedHost === MJ_TENANT) {
        const result = await collectMjLeiloes(normalizedHost, Math.max(0, limit - lots.length), attempt, fetchText);
        lots.push(...result.lots);
        fetched += result.fetched;
        skipped += result.skipped;
        httpStatus = result.httpStatus || httpStatus;
        if (result.note) notes.push(`${host}: ${result.note}`);
        continue;
      }
      if (isMonitorOnlyDomain(normalizedHost)) {
        monitorAttemptFinished = true;
        const monitored = await collectHtmlAgendaMonitor(normalizedHost, attempt, fetchText);
        fetched += monitored.fetched;
        skipped += monitored.skipped;
        httpStatus = monitored.httpStatus || httpStatus;
        continue;
      }
      const base = `https://${host}`;
      const urls = new Set<string>();
      let homeBody = '';
      const catalogPaths = REVIEWED_CATALOG_PATHS[normalizedHost];
      for (const p of catalogPaths ?? PAGINAS) {
        if (lots.length >= limit) { truncated = true; break; }
        throwIfCancelled();
        try {
          const r = await linksDePagina(base, p, attempt);
          if (p === '/' || r.links.length) httpStatus = r.status || httpStatus;
          if (p === '/') {
            homeBody = r.body;
            if (r.status !== 200 || isBlockedPage(r.body)) break;
          }
          if (catalogPaths) reviewedCatalogLotLinks(r.body, base).forEach((l) => urls.add(l));
          else r.links.forEach((l) => urls.add(l));
        } catch (error) {
          // falha de rede já registrada pela função; cancelamento corta o laço
          if (error instanceof CollectionCancellationError) throw error;
        }
      }
      if (isBlockedPage(homeBody)) throw blockedPageError(httpStatus);
      if (/catalogo\.asp\?Num=/i.test(homeBody)) {
        const parsed = await aspCatalog(base, homeBody, attempt, Math.max(0, limit - lots.length));
        lots.push(...parsed.lots);
        fetched += parsed.fetched;
        skipped += parsed.skipped;
        httpStatus = parsed.httpStatus || httpStatus;
        truncated ||= parsed.truncated;
      }
      for (const u of urls) {
        if (lots.length >= limit) { truncated = true; break; }
        throwIfCancelled();
        fetched++;
        const lot = await loteDeUrl(host, u, attempt);
        if (lot) lots.push(lot); else skipped++;
      }
      if (lots.length >= limit) truncated = true;
      } catch (error) {
        if (!isMonitorOnlyDomain(host)) {
          if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
          else attempt?.failure('parser');
        }
        throw error;
      } finally {
        if (!monitorAttemptFinished) await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
    }
    return { lots, fetched, skipped, httpStatus, note: notes.length ? notes.join('; ') : undefined };
  },
};
