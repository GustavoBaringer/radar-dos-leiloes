import type { CanonicalLot, LotStatus, AssetType } from '../core/types.js';
import { classifyAsset, classifyProperty, looksLikePart, looksLikeCollectible, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';
import * as cheerio from 'cheerio';

const jsonVar = (html: string, name: string): any | null => {
  const m = new RegExp(`\\bvar\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`).exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
const phpDate = (v: any): Date | null => {
  const s = typeof v === 'string' ? v : v?.date;
  if (!s) return null;
  const t = Date.parse(`${String(s).slice(0, 19).replace(' ', 'T')}-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
};
export const ofertaStatus = (item: any, auction: any, end: Date | null, now = Date.now()): LotStatus => {
  const s = String(item?.statusString ?? '').toLowerCase();
  if (/vendid|arrematad/.test(s)) return 'vendido';
  if (/encerrad|cancelad|suspens|desert/.test(s)) return 'encerrado';
  if (/aberto/.test(s)) return end && end.getTime() < now ? 'encerrado' : 'aberto';
  if (/agendad|breve/.test(s)) return 'agendado';
  const event = String(auction?.statusString ?? '').toLowerCase();
  if (/vendid|arrematad/.test(event)) return 'vendido';
  if (/encerrad|cancelad|suspens|desert/.test(event)) return 'encerrado';
  // Numeric item status 1 is the observed active/open code in ABA and Marco.
  if (Number(item?.status) === 1) return end && end.getTime() < now ? 'encerrado' : 'aberto';
  if (/aberto/.test(event) && Number.isFinite(Number(item?.status))) return 'sem_data';
  if (/agendad|breve/.test(event)) return 'agendado';
  return 'sem_data';
};
const money = (x: any): number | null => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

/** Parse the individually addressable offer payload, without evaluating page scripts. */
export function parseSuporteOferta(html: string, host: string, url: string): CanonicalLot | null {
  const item = jsonVar(html, 'lote'), auction = jsonVar(html, 'leilao');
  if (!item || !auction || !item.titulo) return null;
  const title = String(item.titulo).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const tags = (Array.isArray(item.tags) ? item.tags : []).map((t: any) => String(t?.code ?? t?.name ?? '')).join(' ');
  if (looksLikePart(title) || looksLikeCollectible(`${title} ${tags}`)) return null;
  const cls = classifyAsset(title, tags);
  const asset: AssetType = cls.assetType;
  if (asset !== 'imovel' && asset !== 'veiculo') return null;
  const end = phpDate(auction.dataProximoLeilao);
  const lotStatus = ofertaStatus(item, auction, end);
  const photos = new Set<string>();
  const $ = cheerio.load(html);
  $('#lote-image[src*="/bens/"], #lote-image-container img[src*="/bens/"], .lote-thumbs a[href*="/bens/"], .page-lote .c-slide img[src*="/bens/"], .page-lote .lote-thumbs a[href*="/bens/"]').each((_, node) => {
    const src = $(node).attr('src') ?? $(node).attr('href');
    if (src) photos.add(new URL(src, `https://${host}`).href);
  });
  const files = item?.bem?.arquivos ?? item?.item?.arquivos ?? item?.arquivos ?? [];
  for (const f of Array.isArray(files) ? files : []) {
    const src = f?.url ?? f?.full?.url;
    if (src && /\/bens\/|\/arquivos\//i.test(src)) photos.add(new URL(src, `https://${host}`).href);
  }
  const normalizedHost = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const id = String(item.aid ?? /\/id-(\d+)/.exec(url)?.[1] ?? '');
  if (!id) return null;
  const parsed = asset === 'veiculo' ? parseTitle(title) : null;
  return {
    sourceId: 'suporteleiloes', externalId: `${normalizedHost}:oferta:${id}`, lotUrl: new URL(url, `https://${normalizedHost}`).href,
    titleRaw: title, sourceCategory: tags || null, assetType: asset,
    propertyType: asset === 'imovel' ? classifyProperty(title, tags) : null,
    vehicleType: asset === 'veiculo' ? cls.vehicleType : null,
    closingModel: 'pregao_em_horario', auctionEndUtc: end, auctionStartUtc: end,
    sourceTz: 'America/Fortaleza', status: lotStatus,
    auctioneerName: campos.nomeDeLeiloeiro(auction.leiloeiro),
    currentBid: money(item.valorAtual), minBid: money(item.valorMinimo), bidIncrement: money(item.valorIncremento),
    city: campos.localDeTexto(title)?.city ?? null, state: campos.localDeTexto(title)?.uf ?? null,
    photos: [...photos], photoCount: photos.size,
    brand: parsed?.brand ?? null, model: parsed?.model ?? null, version: parsed?.version ?? null,
    yearMake: parsed?.yearMake ?? null, yearModel: parsed?.yearModel ?? null,
    raw: { tenant: normalizedHost, sourceId: item.id, itemId: item.aid, eventId: auction.id, eventAid: auction.aid,
      itemStatus: item.status, eventStatus: auction.statusString, directSale: Boolean(auction.vendaDireta) },
  } as CanonicalLot;
}

export function ofertaLinks(html: string, host: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']*\/oferta\/leilao\/[^"'#?]*)["']/gi)) out.add(new URL(m[1], `https://${host}`).href);
  return [...out];
}
export function eventoEncerrado(html: string): boolean {
  const leilao = jsonVar(html, 'leilao');
  return /vendid|arrematad|encerrad|cancelad|suspens|desert/i.test(String(leilao?.statusString ?? ''));
}
export function eventoLinks(html: string, host: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']*\/leiloes\/\d+[^"']*)["']/gi)) out.add(new URL(m[1], `https://${host}`).href);
  return [...out];
}

/** Event cards are only followed when the listing explicitly marks them active/upcoming. */
export function eventosAtivos(html: string, host: string): string[] {
  const $ = cheerio.load(html), out = new Set<string>();
  const cards = [...$('.isotope-item').toArray(), ...$('.flex-leiloes article').toArray()];
  for (const node of cards) {
    const card = $(node);
    const status = `${card.find('#nm_statusmontagem, #nm_statusleilao, .leilao-online').text()} ${card.attr('class') ?? ''}`.toLowerCase();
    if (/encerrad|cancelad|suspens|vendid|arrematad|desert/.test(status) || !/aberto|breve|online|proximos/.test(status)) continue;
    card.find('a[href*="/leiloes/"]').each((_, a) => {
      const href = $(a).attr('href');
      if (href && /\/leiloes\/\d+/.test(href)) {
        const url = new URL(href, `https://${host}`);
        if (url.hostname === host) out.add(url.href);
      }
    });
  }
  return [...out];
}

/** Pagination links actually present on the event page; no guessed page numbers. */
export function eventNextPages(html: string, host: string, currentUrl = `https://${host}/`): string[] {
  const $ = cheerio.load(html), out = new Set<string>();
  $('a[href*="page="]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const url = new URL(href, currentUrl);
    if (url.hostname === host && /\/leiloes\/\d+/.test(url.pathname) && url.searchParams.has('page')) out.add(url.href);
  });
  return [...out];
}
