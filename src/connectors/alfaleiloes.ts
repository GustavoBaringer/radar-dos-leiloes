import * as cheerio from 'cheerio';
import { fetchTenantText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';

const HOST = 'https://www.alfaleiloes.com';
const TENANT = 'alfaleiloes.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}
function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/vendid|encerrad|cancelad|suspens/.test(t)) return 'encerrado';
  if (/aberto/.test(t)) return 'aberto';
  if (/futuro|breve|aguarda/.test(t)) return 'agendado';
  return 'sem_data';
}

function parseAlfaCardsDetailed(html: string, pageUrl: string) {
  const $ = cheerio.load(html), out: CanonicalLot[] = [], seen = new Set<string>();
  let outOfScope = 0, duplicates = 0;
  $('.home-leiloes-cards').each((_, node) => {
    const card = $(node), href = card.find('a[href*="/lote/"]').first().attr('href');
    if (!href) { outOfScope++; return; }
    let url: URL;
    try { url = new URL(href, pageUrl); } catch { outOfScope++; return; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.toLowerCase().replace(/^www\./, '') !== TENANT) { outOfScope++; return; }
    const id = /\/lote\/(\d+)\//.exec(url.pathname)?.[1];
    if (!id) { outOfScope++; return; }
    if (seen.has(id)) { duplicates++; return; }
    seen.add(id);
    const title = card.find('.card-content p').first().text().replace(/\s+/g, ' ').trim();
    if (!title) { outOfScope++; return; }
    const folded = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!/\b(apartamento|casa|sobrado|terreno|imovel|fazenda|sitio|chacara|gleba|vaga|box|predio|sala comercial|galpao)\b/.test(folded)) { outOfScope++; return; }
    const dates = [...card.text().matchAll(/(\d{2}\/\d{2}\/\d{4}\s+às\s+\d{2}:\d{2})/g)].map(m => m[1]);
    const bids = card.find('[js-money]').map((_, el) => dinheiro($(el).text())).get().filter((n): n is number => n != null);
    const statusText = card.find('.card-status').text().trim();
    const category = card.find('.card-content-judicial p').first().text().trim();
    const photo = card.find('img').first().attr('src');
    const local = campos.localDeTexto(title);
    out.push({
      sourceId: 'alfaleiloes', externalId: id, lotUrl: url.href, auctioneerName: 'Alfa Leilões', titleRaw: title,
      sourceCategory: category || null, assetType: 'imovel', docType: category.toLowerCase() || null,
      closingModel: 'timer_por_lote', auctionStartUtc: dataBr(dates[0]), auctionEndUtc: dataBr(dates.at(-1)) ?? dataBr(dates[0]),
      sourceTz: 'America/Sao_Paulo', status: statusDe(statusText), minBid: bids.at(-1) ?? bids[0] ?? null,
      sellerType: classifySeller(null) as any, city: local?.city ?? null, state: local?.uf ?? null,
      photos: photo ? [new URL(photo, pageUrl).href] : [], raw: { statusTexto: statusText },
    });
  });
  return { lots: out, outOfScope, duplicates };
}

export function parseAlfaCards(html: string, pageUrl: string): CanonicalLot[] {
  return parseAlfaCardsDetailed(html, pageUrl).lots;
}

export function parseAlfaPage(html: string, pageUrl: string, limit: number, seen: Set<string> = new Set()) {
  const $ = cheerio.load(html), fetched = $('.home-leiloes-cards').length;
  const parsed = parseAlfaCardsDetailed(html, pageUrl);
  let duplicates = parsed.duplicates;
  const eligible = parsed.lots.filter((lot) => {
    if (seen.has(lot.externalId)) { duplicates++; return false; }
    seen.add(lot.externalId);
    return true;
  });
  const lots = eligible.slice(0, limit);
  const overLimit = Math.max(0, eligible.length - lots.length);
  const nextPages: string[] = [];
  $('a[href*="page="]').each((_, a) => {
    const link = new URL($(a).attr('href')!, pageUrl);
    if (link.hostname.toLowerCase().replace(/^www\./, '') === TENANT && link.pathname.replace(/\/$/, '') === '/leiloes' && Number(link.searchParams.get('page')) > 1) {
      nextPages.push(link.href);
    }
  });
  return { lots, fetched, outOfScope: parsed.outOfScope, duplicates, overLimit, skipped: parsed.outOfScope + duplicates + overLimit, nextPages: [...new Set(nextPages)] };
}

export const alfaleiloes: Connector = {
  def: { id: 'alfaleiloes', name: 'Alfa Leilões', platform: 'Alfa Leilões', method: 'html', tier: 3,
    siteUrl: HOST, notes: 'Catálogo público /leiloes/ paginado; sem total global confiável.' },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [], seenLots = new Set<string>(), seenPages = new Set<string>();
    const queue = [`${HOST}/leiloes/`];
    let fetched = 0, skipped = 0, overLimit = 0, httpStatus = 0;
    while (queue.length && lots.length < limit) {
      const pageUrl = queue.shift()!;
      if (seenPages.has(pageUrl)) continue;
      seenPages.add(pageUrl);
      let response;
      try { response = await fetchTenantText(pageUrl, TENANT, { headers: { 'user-agent': UA }, gapMs: 1100 }); }
      catch { break; }
      httpStatus = response.status;
      if (response.status !== 200) break;
      const page = parseAlfaPage(response.body, response.url, limit - lots.length, seenLots);
      fetched += page.fetched;
      skipped += page.skipped;
      overLimit += page.overLimit;
      lots.push(...page.lots);
      for (const next of page.nextPages) if (!seenPages.has(next) && !queue.includes(next)) queue.push(next);
    }
    const limitReached = lots.length >= limit;
    return {
      lots, fetched, skipped, httpStatus,
      note: `cobertura parcial: catálogo sem total global confiável${limitReached ? `; limite atingido; ${overLimit} cards elegíveis excedentes das páginas lidas contabilizados em skipped` : ''}${queue.length ? '; havia páginas observadas não percorridas pelo limite' : ''}`,
    };
  },
};
