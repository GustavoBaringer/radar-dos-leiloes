import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { CanonicalLot } from '../core/types.js';
import type { Connector, CollectOptions, CollectResult } from './types.js';
import { classifyAsset, classifyProperty, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';

const HOST = 'www.celsocunhaleiloes.com.br';
const EVENT = `https://${HOST}/leilao/14/leilao-autarquia-municipal-de-transito-e-cidadania-amc`;
const money = (s: string): number | null => {
  const n = Number(s.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function celsocunhaPages(html: string, currentUrl = EVENT): string[] {
  const $ = cheerio.load(html), pages = new Set<string>();
  $('[data-page]').each((_, el) => {
    const n = Number($(el).attr('data-page'));
    if (Number.isInteger(n) && n >= 1) {
      const u = new URL(currentUrl);
      u.search = `?page=${n}&categoria=&descricao=`;
      pages.add(u.href);
    }
  });
  return [...pages];
}

export function parseCelsocunhaDetail(html: string, url: string, event: { start: Date | null; auctioneer: string | null } | null = null): CanonicalLot | null {
  const $ = cheerio.load(html);
  const title = clean($('.title-lote').first().text()) || clean($('h1').first().text()) || clean($('title').text().replace(/\s*[|–-].*$/, ''));
  if (!title) return null;
  const text = clean($('body').text());
  const detail = $('.description').text();
  const category = clean(detail.match(/Tipo de bem:\s*([^\n»]+)/i)?.[1] ?? '');
  const condition = clean(detail.match(/Cond\. Funcionamento:\s*([^\n»]*)/i)?.[1] ?? '');
  const sourceCondition = clean(detail.match(/Status:\s*([^\n»]*)/i)?.[1] ?? '');
  const lotEventHref = $('.title-leilao a').attr('href') ?? '';
  if (!/\/leilao\/14\//.test(lotEventHref)) return null;
  if (looksLikePart(title) || looksLikeCollectible(title)) return null;
  const cls = classifyAsset(title, category);
  if (cls.assetType !== 'veiculo' && cls.assetType !== 'imovel') return null;
  const statusText = clean($('.about').text());
  const year = /Ano:\s*((?:19|20)\d{2})\s*\/\s*((?:19|20)\d{2})/i.exec(detail);
  const id = /\/lote\/(\d+)\//.exec(url)?.[1];
  if (!id) return null;
  const photos = new Set<string>();
  $('.fotos img[src], .galeria img[src], .imagem-lote img[src], img[src*="/imgTmp/"]').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('href') ?? '';
    if (!/sem_foto/i.test(src) && /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(src)) { try { photos.add(new URL(src, url).href); } catch {} }
  });
  const parsed = cls.assetType === 'veiculo' ? parseTitle(title) : null;
  const initial = $('.title_lance').parent().parent().find('h2').text();
  const minBid = money(initial);
  return {
    sourceId: 'celsocunha', externalId: id, lotUrl: url, titleRaw: title,
    assetType: cls.assetType, vehicleType: cls.assetType === 'veiculo' ? cls.vehicleType : null,
    propertyType: cls.assetType === 'imovel' ? classifyProperty(title, category) : null,
    sourceCategory: [category, condition ? `Condição: ${condition}` : '', sourceCondition ? `Status: ${sourceCondition}` : ''].filter(Boolean).join(' | ') || null,
    yearMake: year ? Number(year[1]) : parsed?.yearMake ?? null, yearModel: year ? Number(year[2]) : parsed?.yearModel ?? null,
    closingModel: 'pregao_em_horario', auctionStartUtc: event?.start ?? null, auctionEndUtc: null,
    sourceTz: 'America/Sao_Paulo', status: /\bvendido\b|\barrematado\b/i.test(statusText) ? 'vendido' : /\bencerrado\b/i.test(statusText) ? 'encerrado' : /\bagendado\b|\brealiza-se\b/i.test(statusText) ? 'agendado' : /\baberto\b/i.test(statusText) ? 'aberto' : 'sem_data',
    minBid, bidIncrement: null, currentBid: null,
    auctioneerName: event?.auctioneer ?? null, photos: [...photos], raw: { eventId: '14', condition: condition || null, sourceCondition: sourceCondition || null, sourceStatus: statusText || null },
    brand: parsed?.brand ?? null, model: parsed?.model ?? null, version: parsed?.version ?? null,
  };
}

export function parseCelsocunhaEvent(html: string) {
  const $ = cheerio.load(html);
  const dateText = clean($('.data').first().text());
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})/.exec(dateText);
  const start = m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) + 3, Number(m[5]))) : null;
  const auctioneer = clean($('p').filter((_, p) => /Leiloeiro:/.test($(p).text())).first().text().replace(/^.*Leiloeiro:\s*/i, '')) || null;
  const status = clean($('.status').first().text());
  return { start, auctioneer, status };
}

export async function collectCelsocunha(limit: number, request: typeof fetchText = fetchText): Promise<CollectResult> {
  const lots: CanonicalLot[] = [], seen = new Set<string>();
  let fetched = 0, skipped = 0, httpStatus = 0, partial = false;
  const first = await request(`${EVENT}?page=1&categoria=&descricao=`, { gapMs: 1100, timeoutMs: 30000 });
  httpStatus = first.status;
  if (first.status !== 200) return { lots, fetched, skipped: 1, httpStatus, note: 'falha ao carregar evento; coleta parcial' };
  const event = parseCelsocunhaEvent(first.body);
  const pages = celsocunhaPages(first.body);
  if (!pages.length) return { lots, fetched, skipped: 1, httpStatus, note: 'paginação não encontrada' };
  const candidateLimit = Math.min(100, limit);
  for (const page of pages) {
    if (seen.size >= candidateLimit) { partial = true; break; }
    const response = new URL(page).searchParams.get('page') === '1' ? first : await request(page, { gapMs: 1100, timeoutMs: 30000 });
    httpStatus = response.status;
    if (response.status !== 200) { partial = true; skipped++; continue; }
    const $ = cheerio.load(response.body);
    const links = new Set<string>();
    $('a[href*="/lote/"]').each((_, el) => { try { links.add(new URL($(el).attr('href')!, page).href); } catch {} });
    for (const url of links) {
      const id = /\/lote\/(\d+)\//.exec(url)?.[1];
      if (!id || seen.has(id)) continue;
      if (seen.size >= candidateLimit) { partial = true; break; }
      seen.add(id);
      let detail;
      try { detail = await request(url, { gapMs: 1100, timeoutMs: 30000 }); }
      catch { skipped++; partial = true; continue; }
      httpStatus = detail.status;
      if (detail.status !== 200) { skipped++; partial = true; continue; }
      fetched++;
      const lot = parseCelsocunhaDetail(detail.body, url, event);
      if (lot) lots.push(lot); else skipped++;
    }
    if (lots.length >= candidateLimit) { partial = true; break; }
  }
  return { lots, fetched, skipped, httpStatus, note: partial || lots.length >= Math.min(100, limit) ? 'cobertura parcial: limite ou páginas observadas' : undefined };
}

export const celsocunha: Connector = {
  def: { id: 'celsocunha', name: 'Celso Cunha Leilões', platform: 'celsocunha', method: 'html', tier: 2, siteUrl: `https://${HOST}`, notes: 'Evento público observado; usa somente páginas indicadas por data-page, máximo de 100 lotes.' },
  async collect({ limit }: CollectOptions) { return collectCelsocunha(limit); },
};
