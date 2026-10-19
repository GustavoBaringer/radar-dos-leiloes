import * as cheerio from 'cheerio';
import type { CanonicalLot } from '../core/types.js';
import { chromium, type Browser } from 'playwright-core';
import { classifyAsset, classifyProperty, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import { fetchText } from './http.js';
import type { FetchResult } from './http.js';
import type { CollectOptions, CollectResult, Connector } from './types.js';

const PORTAL_HOST = 'portaldosleiloes.com.br';
const GHVM_HOST = 'www.ghvmleiloes.com.br';
const PAGE_CAP = 1000;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 1000);
const normTenant = (v: string) => v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const abort = () => throwIfCancelled();

interface PublicPageIO {
  fetchText: typeof fetchText;
  renderPage?: (url: string) => Promise<FetchResult & { finalUrl?: string }>;
  close?: () => Promise<void>;
}

function publicPageIO(): PublicPageIO {
  let browser: Browser | undefined;
  return {
    fetchText,
    async renderPage(url) {
      abort();
      browser ??= await chromium.launch({ headless: true });
      const page = await browser.newPage();
      try {
        await page.route('**/*', (route) => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1200);
        abort();
        return { status: response?.status() ?? 0, body: await page.content(), headers: {}, finalUrl: page.url() };
      } finally { await page.close(); }
    },
    async close() { await browser?.close(); browser = undefined; },
  };
}

function tenantHost(tenant: string | undefined, expected: string): string {
  const requested = normTenant(tenant ?? expected);
  if (requested !== expected.replace(/^www\./, '')) throw new Error(`single-tenant '${tenant}' fora da população elegível`);
  return expected;
}

function safeUrl(href: string, base: string, host: string, path: RegExp): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' && u.hostname === host && path.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

function brDate(value: string): Date | null {
  const m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s*(?:às|as)?\s*(\d{1,2})[:h](\d{2}))?/i.exec(value);
  if (!m) return null;
  const [, d, mo, y, h = '0', min = '0'] = m;
  const out = new Date(Date.UTC(+y, +mo - 1, +d, +h + 3, +min));
  return out.getUTCDate() === +d && out.getUTCMonth() === +mo - 1 ? out : null;
}

function money(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.replace(/\u00a0/g, ' ');
  const m = /(?:R\$\s*)?([\d.]+(?:,\d{1,2})?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function classify(title: string, category: string): Pick<CanonicalLot, 'assetType' | 'vehicleType' | 'propertyType'> | null {
  const cat = category.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(imoveis?|imovel|terrenos?|apartamentos?)\b/.test(cat)) {
    return { assetType: 'imovel', vehicleType: null, propertyType: classifyProperty(title, category) };
  }
  if (/\b(veiculos?|carros?|automoveis?|motos?|caminhoes?|maquinas?|equipamentos?)\b/.test(cat)) {
    const result = classifyAsset(title, category);
    if (result.assetType === 'veiculo') return {
      assetType: 'veiculo',
      vehicleType: /harley\s*[- ]?\s*davidson/i.test(title) ? 'moto' : result.vehicleType,
      propertyType: null,
    };
    return null;
  }
  return null;
}

export function parsePortalDetail(url: string, html: string, domain = PORTAL_HOST, categoryHint = ''): CanonicalLot | null {
  const $ = cheerio.load(html);
  const title = clean($('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text().replace(/\s*[·|].*$/, ''));
  const canonical = safeUrl($('link[rel="canonical"]').attr('href') || url, url, domain, /^\/lote\/[^/]+\/?$/);
  if (!title || !canonical || looksLikePart(title) || looksLikeCollectible(title)) return null;
  const normalizedHtml = html.replace(/\\"/g, '"').replace(/\\u00a0/gi, ' ');
  const payload = normalizedHtml.match(/\{"loteId":\d+[\s\S]{0,2500}?\}/)?.[0] ?? '';
  const field = (name: string): string | null => {
    const m = new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|null|true|false)`).exec(payload);
    if (!m || m[1] === 'null') return null;
    try { return m[1].startsWith('"') ? JSON.parse(m[1]) as string : m[1]; } catch { return null; }
  };
  const statusLabel = field('statusLabel') ?? '';
  const status = /vendid|arrematad/i.test(statusLabel) ? 'vendido' : /encerrad|retirad|sem licitante/i.test(statusLabel) ? 'encerrado' : /aberto|lance|proposta/i.test(statusLabel) ? 'aberto' : null;
  const cat = categoryHint || clean($('[data-testid*="categoria"], .lei-lote-categoria').first().text());
  const classified = classify(title, cat);
  if (!classified || !status) return null;
  const lines = [...normalizedHtml.matchAll(/"k":"([^"]+)","v":"((?:\\.|[^"])*)"/g)].map((m) => [m[1], m[2].replace(/\\u00a0/g, ' ')]);
  const value = (label: string) => lines.find(([k]) => k.toLowerCase() === label.toLowerCase())?.[1];
  const photo = $('meta[property="og:image"]').attr('content');
  const dateRaw = field('dataEncerra');
  const date = dateRaw ? new Date(dateRaw) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  const id = field('loteId') || new URL(canonical).pathname.split('/').filter(Boolean).at(-1)!;
  return {
    sourceId: 'portalpublic', externalId: `${domain}:${id}`, lotUrl: canonical, titleRaw: title,
    ...(classified.assetType === 'veiculo' ? parseTitle(title) : {}),
    sourceCategory: cat || null, ...classified, closingModel: 'timer_por_lote',
    auctionStartUtc: null, auctionEndUtc: validDate, sourceTz: 'America/Sao_Paulo', status,
    minBid: money(value('Lance inicial') || $('meta[name="description"]').attr('content')),
    bidIncrement: money(value('Incremento')),
    appraisal: money(value('Avaliação')),
    photos: photo && /^https:\/\//.test(photo) && !/placeholder|no-image|logo\.png/i.test(photo) ? [photo] : [],
    raw: { tenant: domain, category: cat || null, statusLabel },
  };
}

function portalLots(baseUrl: string, html: string, host: string): { links: Array<{ url: string; category: string; status: string }>; pages: string[]; recognized: boolean } {
  const $ = cheerio.load(html), links = new Map<string, { url: string; category: string; status: string }>(), pages = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const eventUrl = safeUrl(href, baseUrl, host, /^\/leilao\/[^/]+\/?$/);
    if (eventUrl && new URL(baseUrl).pathname === '/leiloes') {
      const firstPage = new URL(eventUrl); firstPage.searchParams.set('page', '1'); pages.add(firstPage.href); return;
    }
    const lotUrl = safeUrl(href, baseUrl, host, /^\/lote\/[^/]+\/?$/);
    if (lotUrl && ($(el).hasClass('lei-lote') || $(el).closest('.lei-grid-leiloes, .lei-ev-cards').length > 0)) {
      const text = clean($(el).text());
      const category = /(Veículos|Carros|Automóveis|Imóveis|Máquinas?|Equipamentos)/i.exec(text)?.[1] ?? '';
      const status = /(?:Vendido|Sem Licitantes|Retirado|Aberto para Lances|Em leilão)/i.exec(text)?.[0] ??
        (/is-inativo/i.test($(el).attr('class') ?? '') ? 'Encerrado' : 'Aberto para Lances');
      if (!links.has(lotUrl)) links.set(lotUrl, { url: lotUrl, category, status });
    }
    const pageUrl = safeUrl(href, baseUrl, host, /^\/leilao\/[^/]+\/?$/);
    if (pageUrl && new URL(pageUrl).pathname === new URL(baseUrl).pathname && new URL(pageUrl).searchParams.has('page')) {
      const normalized = new URL(pageUrl); normalized.hash = ''; pages.add(normalized.href);
    }
  });
  return { links: [...links.values()], pages: [...pages], recognized: $('a.lei-lote[href*="/lote/"], .lei-grid-leiloes a[href*="/lote/"], .lei-ev-body').length > 0 || pages.size > 0 };
}

async function getPage(url: string, io: PublicPageIO, attempt?: Awaited<ReturnType<NonNullable<CollectOptions['observer']>['start']>>): Promise<FetchResult & { finalUrl?: string }> {
  abort();
  const response = await io.fetchText(url, { gapMs: 1100, timeoutMs: 30000 });
  attempt?.response(response.status);
  return response;
}

export async function collectPortalPublic(opts: CollectOptions, injectedIO?: PublicPageIO): Promise<CollectResult> {
  const io = injectedIO ?? publicPageIO();
  const host = tenantHost(opts.tenant, PORTAL_HOST), domain = PORTAL_HOST, root = `https://${host}`;
  const attempt = await opts.observer?.start(domain);
  const catalog = `${root}/leiloes?situacao=andamento`, seenPages = new Set<string>(), seenLots = new Set<string>();
  const queue = [catalog], lots: CanonicalLot[] = [];
  let fetched = 0, skipped = 0, httpStatus = 0, truncated = false;
  try {
    while (queue.length && lots.length < opts.limit && seenPages.size < PAGE_CAP) {
      abort(); const url = queue.shift()!;
      if (seenPages.has(url)) continue;
      seenPages.add(url);
      let response = await getPage(url, io, attempt); httpStatus = response.status;
      if (response.status !== 200) throw new Error(`HTTP ${response.status} no catálogo Portal dos Leilões`);
      let parsed = portalLots(url, response.body, host);
      if (!parsed.recognized && io.renderPage) {
        response = await io.renderPage(url); httpStatus = response.status; attempt?.response(response.status);
        if (response.status !== 200) throw new Error(`HTTP ${response.status} no catálogo renderizado Portal dos Leilões`);
        parsed = portalLots(response.finalUrl ?? url, response.body, host);
      }
      if (!parsed.recognized && seenPages.size === 1) throw new Error('catálogo Portal dos Leilões sem template reconhecido');
      for (const next of parsed.pages) if (!seenPages.has(next) && !queue.includes(next)) queue.push(next);
      for (const candidate of parsed.links) {
        if (seenLots.has(candidate.url)) continue;
        seenLots.add(candidate.url); fetched++;
        if (/vendido|sem licitantes|retirado/i.test(candidate.status)) { skipped++; continue; }
        if (!candidate.category) { skipped++; continue; }
        const response = await getPage(candidate.url, io, attempt); httpStatus = response.status;
        if (response.status !== 200) throw new Error(`HTTP ${response.status} no lote Portal dos Leilões`);
        const lot = parsePortalDetail(candidate.url, response.body, domain, candidate.category);
        if (!lot) skipped++; else lots.push(lot);
        if (lots.length >= opts.limit) { truncated = true; break; }
      }
    }
    if (queue.length || seenPages.size >= PAGE_CAP || lots.length >= opts.limit) truncated = true;
    return { lots, fetched, skipped, httpStatus, note: `Portal: ${seenPages.size} páginas reais; ${truncated ? 'cobertura parcial (limite/paginação)' : 'paginação concluída'}` };
  } catch (error) {
    attempt?.failure(error instanceof CollectionCancellationError ? (error.kind === 'deadline' ? 'budget' : 'network') : 'parser');
    throw error;
  } finally {
    try { await attempt?.finish({ fetched, skipped, returned: lots.length, truncated }); }
    finally { await io.close?.(); }
  }
}

export function parseGhvmCard(url: string, html: string, domain = 'ghvmleiloes.com.br', categoryHint = ''): CanonicalLot[] {
  const $ = cheerio.load(html), lots: CanonicalLot[] = [], seen = new Set<string>();
  $('a[href*="/oferta/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const lotUrl = safeUrl(href, url, new URL(url).hostname, /^\/oferta\/[^/]+$/);
    if (!lotUrl || seen.has(lotUrl)) return;
    seen.add(lotUrl);
    const card = $(el).closest('.MuiPaper-root');
    const text = clean(card.text());
    const titleNode = card.find('h1,h2,h3,[class*="jss435"],[class*="jss591"]').first().text();
    const title = clean(titleNode || card.find('p').map((_, p) => clean($(p).text())).get().find((t) =>
      t.length >= 8 && !/^\d{1,2}\/\d{1,2}/.test(t) && !/inicial:|lance|leil[aã]o|pra[cç]a|judicial|parcelados|\blote\s+\d/i.test(t),
    ) || $(el).text() || card.text());
    if (!title || title.length < 8 || /vendid|encerrad|sem licitantes/i.test(text) || looksLikePart(title) || looksLikeCollectible(title)) return;
    const category = categoryHint || (/im[oó]vel|casa|galp[aã]o|terreno|apartamento/i.test(title) ? 'Imóveis' : /m[aá]quina|equipamento/i.test(title) ? 'Máquinas e Equipamentos' : 'Veículos');
    const classified = classify(title, category);
    if (!classified) return;
    const dateText = text.match(/\b\d{1,2}\/\d{1,2}\s*[-–]\s*\d{1,2}:\d{2}/)?.[0];
    const dateParts = dateText?.match(/(\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2}:\d{2})/);
    const date = dateParts ? brDate(`${dateParts[1]}/${dateParts[2]}/${new Date().getFullYear()} ${dateParts[3]}`) : null;
    const future = date && date.getTime() > Date.now() ? date : null;
    const stage = [...text.matchAll(/\d+[ªa]?\s*(?:leil[aã]o\s*\/\s*pra[cç]a|pra[cç]a|leil[aã]o)\s*(\d{1,2}\/\d{1,2})\s*[-–]\s*(\d{1,2}:\d{2})\s*Inicial:\s*(R\$\s*[\d.]+,\d{2})/gi)];
    const futureStage = stage.map((m) => ({ date: brDate(`${m[1]}/${new Date().getFullYear()} ${m[2]}`), value: money(m[3]) })).find((s) => s.date && s.date.getTime() > Date.now());
    const amount = futureStage?.value ?? money(text.match(/Inicial:\s*R\$\s*[\d.,]+/i)?.[0]);
    const image = card.find('img').filter((_, img) => /^https:\/\//.test($(img).attr('src') ?? '')).first().attr('src');
    const slugId = new URL(lotUrl).pathname.split('/').filter(Boolean).at(-1)!;
    lots.push({ sourceId: 'ghvmpublic', externalId: `${domain}:${slugId}`, lotUrl, titleRaw: title,
      ...(classified.assetType === 'veiculo' ? parseTitle(title) : {}), sourceCategory: category, ...classified,
      closingModel: 'timer_por_lote', auctionStartUtc: futureStage?.date ?? future, auctionEndUtc: null,
      sourceTz: 'America/Sao_Paulo', status: 'aberto', minBid: amount, currentBid: null,
      city: clean(text.match(/\b([\p{L} ]+)\s*[•·]\s*[A-Z]{2}\b/u)?.[1] ?? '') || null,
      state: text.match(/[•·]\s*([A-Z]{2})\b/)?.[1] ?? null,
      photos: image && !/placeholder|no-image|logo\.png/i.test(image) ? [image] : [], raw: { tenant: domain, category },
    });
  });
  return lots;
}

export async function collectGhvmPublic(opts: CollectOptions, injectedIO?: PublicPageIO): Promise<CollectResult> {
  const io = injectedIO ?? publicPageIO();
  const host = tenantHost(opts.tenant, GHVM_HOST), root = `https://${host}`;
  const attempt = await opts.observer?.start('ghvmleiloes.com.br');
  const lots: CanonicalLot[] = [], seenUrls = new Set<string>(), candidateSeen = new Set<string>(), seenPages = new Set<string>();
  let fetched = 0, skipped = 0, httpStatus = 0, truncated = false;
  try {
    let first = await getPage(root, io, attempt); httpStatus = first.status;
    if (first.status !== 200) throw new Error(`HTTP ${first.status} na HOME GHVM`);
    let firstUrl = first.finalUrl ?? root;
    let search = new URL(firstUrl);
    search.searchParams.set('searchType', 'opened');
    search.searchParams.set('pageNumber', '1');
    search.searchParams.set('pageSize', '30');
    search.searchParams.set('orderBy', 'endDate:asc');
    firstUrl = search.href;
    let firstLots = parseGhvmCard(firstUrl, first.body, 'ghvmleiloes.com.br');
    if (!firstLots.length && io.renderPage) {
      first = await io.renderPage(root); httpStatus = first.status; attempt?.response(first.status);
      if (first.status !== 200) throw new Error(`HTTP ${first.status} no catálogo GHVM renderizado`);
      search = new URL(first.finalUrl ?? root);
      search.searchParams.set('searchType', 'opened');
      search.searchParams.set('pageNumber', '1');
      search.searchParams.set('pageSize', '30');
      search.searchParams.set('orderBy', 'endDate:asc');
      firstUrl = search.href;
      firstLots = parseGhvmCard(firstUrl, first.body, 'ghvmleiloes.com.br');
    }
    const queue = [firstUrl];
    const htmlByUrl = new Map([[firstUrl, first.body]]);
    while (queue.length && lots.length < opts.limit && seenPages.size < PAGE_CAP) {
      abort();
      const current = queue.shift()!;
      if (seenPages.has(current)) continue;
      seenPages.add(current);
      let html = htmlByUrl.get(current);
      if (html === undefined) {
        const response = await getPage(current, io, attempt); httpStatus = response.status;
        if (response.status !== 200) throw new Error(`HTTP ${response.status} no catálogo GHVM`);
        html = response.body;
      }
      const pageLots = parseGhvmCard(current, html, 'ghvmleiloes.com.br');
      const $ = cheerio.load(html), candidates = new Set<string>();
      $('a[href*="/oferta/"]').each((_, el) => {
        const u = safeUrl($(el).attr('href') ?? '', current, host, /^\/oferta\/[^/]+$/);
        if (u && !candidateSeen.has(u)) candidates.add(u);
      });
      for (const url of candidates) candidateSeen.add(url);
      fetched += candidates.size;
      for (const lot of pageLots) {
        if (!lot.lotUrl || seenUrls.has(lot.lotUrl)) continue;
        seenUrls.add(lot.lotUrl); lots.push(lot);
        if (lots.length >= opts.limit) { truncated = true; break; }
      }
      const pageNo = Number(new URL(current).searchParams.get('pageNumber') ?? 1);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        const next = safeUrl(href, current, host, /^\/$/);
        if (!next) return;
        const u = new URL(next), n = Number(u.searchParams.get('pageNumber'));
        if (u.searchParams.get('searchType') === 'opened' && Number.isSafeInteger(n) && n > pageNo && !seenPages.has(u.href) && !queue.includes(u.href)) queue.push(u.href);
      });
    }
    if (queue.length || seenPages.size >= PAGE_CAP || lots.length >= opts.limit) truncated = true;
    skipped = Math.max(0, fetched - lots.length);
    if (!fetched) throw new Error('catálogo aberto GHVM sem ofertas no template reconhecido');
    return { lots: lots.slice(0, opts.limit), fetched, skipped, httpStatus, note: `GHVM: ${seenPages.size} páginas reais do catálogo aberto; ${truncated ? 'cobertura parcial (limite/paginação)' : 'paginação concluída'}` };
  } catch (error) {
    attempt?.failure(error instanceof CollectionCancellationError ? (error.kind === 'deadline' ? 'budget' : 'network') : 'parser');
    throw error;
  } finally {
    try { await attempt?.finish({ fetched, skipped, returned: lots.length, truncated }); }
    finally { await io.close?.(); }
  }
}

export const portalPublic: Connector = {
  def: { id: 'portalpublic', name: 'Portal dos Leilões', platform: 'portal-dos-leiloes', method: 'html', tier: 4,
    siteUrl: `https://${PORTAL_HOST}`, notes: 'Catálogo público em andamento; descobre eventos e páginas de lote pelo HTML oficial.' },
  collect(opts) { return collectPortalPublic(opts); },
};

export const ghvmPublic: Connector = {
  def: { id: 'ghvmpublic', name: 'GHVM Leilões', platform: 'superbid-exchange', method: 'html', tier: 4,
    siteUrl: `https://${GHVM_HOST}`, notes: 'Apenas categorias abertas publicadas no domínio GHVM; não consulta estoque global Superbid.' },
  collect(opts) { return collectGhvmPublic(opts); },
};
