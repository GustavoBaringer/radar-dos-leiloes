import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { FetchOpts, FetchResult } from './http.js';
import type { CanonicalLot } from '../core/types.js';
import { classifyAsset, classifyProperty, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import type { TenantAttempt } from '../domain/collection/tenant-attempts.js';
import type { Connector, CollectOptions, CollectResult } from './types.js';

/** População revisada deste conector: só estes domínios podem ser coletados. */
export const VIPLEILOES_DOMAINS = ['ericosobral.com.br', 'lancecertoleiloes.com.br'] as const;
const DOMAINS = VIPLEILOES_DOMAINS;
const ERICO_PAGE_CAP = 20;
const normDomain = (value: string) => value.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 500);
const demo = (value: string) => /testevip|leiloeiro\s+modelo|demonstra[cç][aã]o/i.test(value);

function dateBrazil(value: string): Date | null {
  // Cards da HOME escrevem "14/10/2026 as 16h00"; páginas de evento usam "14/10/2026 - 16h00".
  const m = /\b(\d{2})\/(\d{2})\/(\d{4})\s*(?:[-–]|às|as)?\s*(\d{1,2})h(\d{2})\b/i.exec(value);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh) + 3, Number(min));
  const date = new Date(utc);
  return date.getUTCDate() === Number(dd) && date.getUTCMonth() === Number(mm) - 1 ? date : null;
}

function money(value: string): number | null {
  const digits = value.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const amount = Number(digits);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function mapLot(input: {
  domain: string; url: string; href: string; title: string; category: string; subCategory?: string; route: string; status: string;
  image: string | undefined; amount: string; auctionStartUtc: Date | null; seller: string | null;
}): CanonicalLot | null {
  const title = clean(input.title);
  const category = clean(input.category);
  const subCategory = clean(input.subCategory ?? '');
  const classification = `${category} ${subCategory} ${input.route}`;
  // IDs de teste (ex.: TESTEVIP) nunca viram lote publicável.
  if (!title || title.length < 6 || /teste/i.test(input.href) || demo(`${input.href} ${title}`) || looksLikePart(title) || looksLikeCollectible(title)) return null;
  const categoryFolded = classification.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let assetType: 'veiculo' | 'imovel' | null = null;
  let vehicleType: ReturnType<typeof classifyAsset>['vehicleType'] = null;
  let propertyType: ReturnType<typeof classifyProperty> = null;
  if (/\b(imovel|imoveis)\b/.test(categoryFolded)) {
    assetType = 'imovel';
    propertyType = classifyProperty(title, subCategory || category);
  } else if (/\b(veiculos?|carro|automovel|moto|caminhao|onibus|pesados?|maquinas?|equipamentos?)\b/.test(categoryFolded) ||
    (/\boutros\b/.test(input.route) && (/\b(veiculo|automovel|carro|moto|motocicleta|caminhao|onibus|trator|caminhonete|lancha|embarcacao|retroescavadeira|escavadeira|empilhadeira|colheitadeira|motoniveladora)\b/i.test(title) || !!parseTitle(title).brand))) {
    const classified = classifyAsset(title, classification);
    const routeIsOther = /\boutros\b/.test(input.route);
    const recognizedVehicle = /\b(veiculo|automovel|carro|moto|motocicleta|caminhao|onibus|trator|caminhonete|lancha|embarcacao|retroescavadeira|escavadeira|empilhadeira|colheitadeira|motoniveladora)\b/i.test(title) || !!parseTitle(title).brand;
    if (classified.assetType === 'veiculo' && (!routeIsOther || recognizedVehicle)) {
      assetType = 'veiculo';
      vehicleType = classified.vehicleType;
    }
  }
  if (!assetType || !/^aberto$/i.test(input.status)) return null;
  const pathId = input.href.match(/(?:\/|[-_])(\d+)\/?(?:[?#].*)?$/)?.[1];
  if (!pathId) return null;
  const parsed = assetType === 'veiculo' ? parseTitle(title) : null;
  const lotUrl = new URL(input.href, input.url).href;
  const photo = input.image ? new URL(input.image, input.url).href : null;
  return {
    sourceId: 'vipleiloes', externalId: `${input.domain}:${pathId}`, lotUrl,
    titleRaw: title,
    brand: parsed?.brand ?? null, model: parsed?.model ?? null, version: parsed?.version ?? null,
    yearMake: parsed?.yearMake ?? null, yearModel: parsed?.yearModel ?? null,
    sourceCategory: category, sourceGroup: subCategory || null, assetType, vehicleType, propertyType,
    closingModel: 'pregao_em_horario', auctionStartUtc: input.auctionStartUtc, auctionEndUtc: null,
    sourceTz: 'America/Sao_Paulo', status: 'aberto', currentBid: money(input.amount), minBid: null,
    auctioneerName: input.seller, sellerName: null,
    photos: photo ? [photo] : [], raw: { tenant: input.domain, eventUrl: input.url },
  };
}

interface EventLink { url: string; active: boolean; label: string; startUtc: Date | null }

/** cheerio .text() concatena sem espaços ("ABERTOLeilão"); juntar folhas com espaço preserva \b. */
function cardText(card: ReturnType<ReturnType<typeof cheerio.load>>, $: ReturnType<typeof cheerio.load>): string {
  return clean(card.find('*').filter((_, el) => $(el).children().length === 0).map((_, el) => $(el).text()).get().join(' '));
}

function eventLinks(homeUrl: string, html: string): EventLink[] {
  const $ = cheerio.load(html);
  const found = new Map<string, EventLink>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const url = new URL(href, homeUrl);
    if (url.hostname !== new URL(homeUrl).hostname || !/^\/leilao\/\d+\/?$/.test(url.pathname)) return;
    const card = $(element).closest('.auction-card, .leilao-card, .card');
    const text = clean(`${cardText(card, $)} ${$(element).text()}`);
    if (demo(`${href} ${text}`)) return;
    const startUtc = dateBrazil(card.find('.card-value').text()) ?? dateBrazil(text);
    const key = url.href;
    found.set(key, { url: key, active: /\baberto\b/i.test(text) && !!startUtc, label: text, startUtc });
  });
  return [...found.values()];
}

function ericoLots(eventUrl: string, html: string, domain: string, cardStartUtc: Date | null): { lots: CanonicalLot[]; cards: number; validEvent: boolean } {
  const $ = cheerio.load(html);
  const eventStatus = clean($('#Holder_lblStatus').text());
  const auctionStartUtc = dateBrazil($('#Holder_lblLeilaoData').text()) ?? cardStartUtc;
  const validEvent = /^aberto$/i.test(eventStatus) && !!auctionStartUtc;
  const lots: CanonicalLot[] = [];
  const cards = $('#Holder_lll .auction-card').length;
  if (!validEvent) return { lots, cards, validEvent };
  $('#Holder_lll .auction-card').each((_, element) => {
    const card = $(element);
    const anchor = card.find('a[href]').first();
    const href = anchor.attr('href') ?? '';
    const lot = mapLot({
      domain, url: eventUrl, href, title: clean(card.find('.address').text()),
      category: clean(card.find('strong').first().text()), route: '',
      status: clean(card.find('.status-lt1').text()), image: card.find('img').first().attr('src'),
      amount: card.find('.valor-lance').text(), auctionStartUtc, seller: 'Érico Sobral',
    });
    if (lot) lots.push(lot);
  });
  return { lots, cards, validEvent };
}

interface LanceCard { href: string; title: string; category: string; image?: string; amount: string }

function lanceCategoryLinks(homeUrl: string, html: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const url = new URL(href, homeUrl);
    if (url.hostname === new URL(homeUrl).hostname && /^\/filtro\/(imoveis|carros|motos|pesados|outros)\/?$/.test(url.pathname)) found.add(url.href);
  });
  return [...found];
}

function lanceCards(pageUrl: string, html: string, route: string): LanceCard[] {
  const $ = cheerio.load(html);
  const found = new Map<string, LanceCard>();
  $('#ContentPlaceHolder1_dvLote .btn-leilao a[href]').each((_, el) => {
    const a = $(el), href = a.attr('href') ?? '';
    const url = new URL(href, pageUrl);
    if (url.hostname !== new URL(pageUrl).hostname || !/^\/leilao\/[^/]+\/lote\/\d+\/?$/.test(url.pathname) || demo(`${href} ${a.text()}`)) return;
    const card = a.closest('.btn-leilao');
    const id = url.pathname.match(/\/lote\/(\d+)/)?.[1];
    if (!id) return;
    const amount = `${card.find('.lote-valor').first().text()}${card.find('.lote-valor-centavo').first().text()}`;
    found.set(id, { href: url.href, title: clean(card.find('.lote-descricao').text()), category: route, image: card.find('img.lote-img').attr('src'), amount });
  });
  return [...found.values()];
}

function lanceDetail(url: string, html: string, domain: string, card: LanceCard): CanonicalLot | null {
  const $ = cheerio.load(html);
  const category = clean($('#ContentPlaceHolder1_lblCategoria').text()) || card.category;
  const subCategory = clean($('#ContentPlaceHolder1_lblCate').text());
  const description = clean($('#ContentPlaceHolder1_lblDescricaoImovel, #ContentPlaceHolder1_lblOutros, #ContentPlaceHolder1_lblDescricao').first().text());
  const title = clean([$('#ContentPlaceHolder1_lblTitulo1').text(), $('#ContentPlaceHolder1_lblTitulo2').text(), description].filter(Boolean).join(' - ')) || card.title;
  const date = dateBrazil($('#ContentPlaceHolder1_lblDataleilao').text()) ?? dateBrazil(card.title);
  const status = clean($('#ContentPlaceHolder1_lblStatus').text());
  return mapLot({ domain, url, href: card.href, title, category, subCategory, route: card.category, status, image: card.image, amount: card.amount, auctionStartUtc: date, seller: 'Lance Certo' });
}

function canonicalCategoryPage(value: string): string {
  const url = new URL(value);
  if (url.searchParams.get('pag') === '1') url.searchParams.delete('pag');
  return url.href;
}

/** Lance Certo publica os cards e páginas de lote sem autenticação. */
async function lanceCatalog(host: string, domain: string, limit: number, get: (url: string) => Promise<FetchResult | null>): Promise<{ lots: CanonicalLot[]; fetched: number; skipped: number; truncated: boolean; note: string }> {
  const homeUrl = `https://${host}/home`;
  const home = await get(homeUrl);
  if (!home) return { lots: [], fetched: 0, skipped: 0, truncated: true, note: 'falha de rede na HOME' };
  if (home.status !== 200) return { lots: [], fetched: 0, skipped: 0, truncated: true, note: `HTTP ${home.status} na HOME` };
  const categories = lanceCategoryLinks(homeUrl, home.body);
  if (!categories.length) throw new Error('HOME Lance Certo sem filtros de categoria reconhecidos');
  const lots: CanonicalLot[] = [], seen = new Set<string>();
  let fetched = 0, skipped = 0, truncated = false, pages = 0, httpFailures = 0;
  for (const categoryUrl of categories) {
    const route = new URL(categoryUrl).pathname.split('/').pop() ?? '';
    const queue = [canonicalCategoryPage(categoryUrl)], visitedPages = new Set<string>(), categoryCards = new Set<string>();
    let announcedCount = 0, announcedKnown = false;
    while (queue.length && lots.length < limit) {
      throwIfCancelled();
      const pageUrl = canonicalCategoryPage(queue.shift()!);
      if (visitedPages.has(pageUrl)) continue;
      visitedPages.add(pageUrl); pages++;
      const response = await get(pageUrl);
      if (!response) { truncated = true; continue; }
      if (response.status !== 200) { truncated = true; httpFailures++; continue; }
      const $ = cheerio.load(response.body);
      const totalText = $('#ContentPlaceHolder1_lblTotalRegistros').text().trim();
      if (totalText && Number.isFinite(Number(totalText))) {
        announcedKnown = true;
        announcedCount = Math.max(announcedCount, Number(totalText));
      }
      $('.pagination a[href], a[rel="next"]').each((_, el) => {
        const next = new URL($(el).attr('href') ?? '', pageUrl);
        if (next.hostname === new URL(pageUrl).hostname && next.pathname === new URL(categoryUrl).pathname) {
          const canonical = canonicalCategoryPage(next.href);
          if (!visitedPages.has(canonical) && !queue.includes(canonical)) queue.push(canonical);
        }
      });
      for (const card of lanceCards(pageUrl, response.body, route)) {
        categoryCards.add(card.href);
        if (seen.has(card.href)) continue;
        seen.add(card.href); fetched++;
        const detail = await get(card.href);
        if (!detail || detail.status !== 200) { skipped++; truncated = true; if (detail) httpFailures++; continue; }
        const lot = lanceDetail(card.href, detail.body, domain, card);
        if (lot) lots.push(lot); else skipped++;
        if (lots.length >= limit) { truncated = true; break; }
      }
    }
    if (queue.length || !announcedKnown || categoryCards.size < announcedCount) truncated = true;
    if (lots.length >= limit) break;
  }
  const note = truncated || httpFailures ? `${fetched} cards reais avaliados em ${pages} páginas; TESTEVIP excluídos; ${httpFailures ? `falhas HTTP: ${httpFailures}; ` : ''}cobertura parcial (limite/paginação)` : '';
  return { lots, fetched, skipped, truncated, note };
}

export async function collectVipLeiloes(
  { limit, observer, tenant }: CollectOptions,
  io: { fetchText: (url: string, opts?: FetchOpts) => Promise<FetchResult> } = { fetchText },
): Promise<CollectResult> {
  const requested = tenant === undefined ? [...DOMAINS] : [normDomain(tenant)];
  if (requested.some((domain) => !DOMAINS.includes(domain as typeof DOMAINS[number]))) {
    throw new Error(`single-tenant '${tenant}' fora da população elegível de vipleiloes`);
  }
  const hosts = requested.map((domain) => `www.${domain}`);
  const quota = tenant === undefined ? Math.max(1, Math.ceil(limit / hosts.length)) : limit;
  const lots: CanonicalLot[] = [];
  let fetched = 0, skipped = 0, httpStatus = 0;
  const notes: string[] = [];

  for (let i = 0; i < hosts.length && lots.length < limit; i++) {
    const host = hosts[i];
    const domain = normDomain(host);
    const attempt = await observer?.start(domain);
    const before = lots.length, fetchedBefore = fetched, skippedBefore = skipped;
    let truncated = false;
    try {
      const get = async (url: string): Promise<FetchResult | null> => {
        throwIfCancelled();
        try {
          const response = await io.fetchText(url, { gapMs: 1100, timeoutMs: 30000, headers: { referer: `https://${host}/` } });
          attempt?.response(response.status);
          httpStatus = response.status;
          return response;
        } catch (error) {
          if (error instanceof CollectionCancellationError) throw error;
          throwIfCancelled();
          attempt?.failure('network');
          return null;
        }
      };

      if (domain === 'ericosobral.com.br') {
        const homeUrl = `https://${host}/`;
        const home = await get(homeUrl);
        if (!home) { notes.push(`${domain}: falha de rede na HOME`); continue; }
        if (home.status !== 200) { notes.push(`${domain}: HTTP ${home.status} na HOME`); continue; }
        const candidates = eventLinks(homeUrl, home.body).filter((event) => event.active);
        if (!candidates.length) {
          attempt?.failure('parser');
          notes.push(`${domain}: HOME sem evento ativo reconhecido; cobertura pendente`);
          continue;
        }
        const visited = new Set<string>();
        for (const event of candidates.slice(0, ERICO_PAGE_CAP)) {
          throwIfCancelled();
          if (lots.length - before >= quota || lots.length >= limit) { truncated = true; break; }
          const response = await get(event.url);
          if (!response) continue;
          if (response.status !== 200) continue;
          const result = ericoLots(event.url, response.body, domain, event.startUtc);
          fetched += result.cards;
          if (!result.validEvent) { skipped += result.cards; continue; }
          let accepted = 0;
          for (const lot of result.lots) {
            if (visited.has(lot.externalId)) continue;
            visited.add(lot.externalId);
            if (lots.length - before >= quota || lots.length >= limit) { truncated = true; break; }
            lots.push(lot);
            accepted++;
          }
          skipped += result.cards - accepted;
          if (truncated) break;
        }
        // HOME discovery is intentionally one bounded pass; pagination completeness is unconfirmed.
        truncated = true;
        if (candidates.length > ERICO_PAGE_CAP) truncated = true;
      } else {
        const catalog = await lanceCatalog(host, domain, Math.min(quota, limit - lots.length), get);
        lots.push(...catalog.lots.slice(0, limit - lots.length));
        fetched += catalog.fetched;
        skipped += catalog.skipped;
        truncated = catalog.truncated;
        if (catalog.note) notes.push(`${domain}: ${catalog.note}`);
        // O `finally` abaixo faz o finish do tenant com os totais
        // acumulados (já inclui as páginas do catálogo lidas aqui).
      }
    } catch (error) {
      if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
      else { attempt?.failure('parser'); throw error; }
      throw error;
    } finally {
      await attempt?.finish({ fetched: fetched - fetchedBefore, skipped: skipped - skippedBefore, returned: lots.length - before, truncated });
    }
  }
  return { lots: lots.slice(0, limit), fetched, skipped, httpStatus, note: notes.length ? notes.join('; ') : undefined };
}

export const vipleiloes: Connector = {
  def: {
    id: 'vipleiloes', name: 'VIP Leilões', platform: 'vip-leiloes', method: 'html', tier: 4,
    siteUrl: 'https://www.ericosobral.com.br',
    notes: 'HTML multi-tenant restrito a Érico Sobral e Lance Certo. Lance Certo: filtros públicos da HOME (imóveis, carros, motos, pesados e outros), cards reais #ContentPlaceHolder1_dvLote .btn-leilao e detalhes públicos; paginação só quando links navegáveis são publicados.',
  },
  async collect(opts) { return collectVipLeiloes(opts); },
};
