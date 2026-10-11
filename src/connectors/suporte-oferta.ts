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
const currentDeadline = (itemDate: any, activePlazaStart: Date | null): Date | null => {
  const deadline = phpDate(itemDate);
  return deadline && activePlazaStart && deadline.getTime() >= activePlazaStart.getTime() ? deadline : null;
};
export const ofertaStatus = (item: any, auction: any, _end: Date | null, _now = Date.now()): LotStatus => {
  const s = String(item?.statusString ?? '').toLowerCase();
  if (/vendid|arrematad/.test(s)) return 'vendido';
  if (/encerrad|cancelad|suspens|desert/.test(s)) return 'encerrado';
  if (/aberto/.test(s)) return 'aberto';
  if (/agendad|breve/.test(s)) return 'agendado';
  const event = String(auction?.statusString ?? '').toLowerCase();
  if (/vendid|arrematad/.test(event)) return 'vendido';
  if (/encerrad|cancelad|suspens|desert/.test(event)) return 'encerrado';
  // Numeric item status 1 is the observed active/open code in ABA and Marco.
  if (Number(item?.status) === 1) return 'aberto';
  if (/aberto/.test(event) && Number.isFinite(Number(item?.status))) return 'sem_data';
  if (/agendad|breve/.test(event)) return 'agendado';
  return 'sem_data';
};
const money = (x: any): number | null => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
const mentionsScrap = (value: string): boolean => /\b(sucata|sucatas|sucateado|sucateada)\b/i.test(value.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
const flattenTerms = (value: any): string[] => Array.isArray(value) ? value.flatMap(flattenTerms)
  : value && typeof value === 'object' ? ['code', 'name', 'label', 'nome', 'descricao', 'slug'].flatMap((key) => flattenTerms(value[key]))
    : value == null ? [] : [String(value)];
const sourceTerms = (...values: any[]): string => values.flatMap(flattenTerms).join(' ');
const fold = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Guard the classifier's unknown-title fallback (`veiculo/carro`) at this source boundary. */
function classifyInScope(title: string, category: string) {
  const classified = classifyAsset(title, category);
  const titleFold = fold(title), categoryFold = fold(category);
  if (classified.assetType === 'imovel') {
    return /\b(imovel|imoveis|terreno|apartamento|casa|fazenda|sitio|chacara|rural|sala comercial|galpao|predio)\b/.test(`${titleFold} ${categoryFold}`) ? classified : null;
  }
  if (classified.assetType !== 'veiculo') return null;
  const explicitVehicle = /\b(veiculo|automovel|carro|motocicleta|moto|caminhao|onibus|trator|caminhonete|embarcacao|lancha)\b/.test(titleFold);
  const vehicleCategory = /\b(veiculos|veiculo|automoveis|automovel|carros|motos|caminhoes|onibus|tratores|maquinas)\b/.test(categoryFold);
  const recognizedBrand = parseTitle(title).brand !== null;
  return explicitVehicle || vehicleCategory || recognizedBrand || classified.vehicleType === 'maquina' ? classified : null;
}

/** Parse the individually addressable offer payload, without evaluating page scripts. */
export function parseSuporteOferta(html: string, host: string, url: string): CanonicalLot | null {
  const item = jsonVar(html, 'lote'), auction = jsonVar(html, 'leilao');
  if (!item || !auction || !item.titulo) return null;
  const description = [item.descricao, item.observacao].filter((v) => v != null && String(v).trim()).map((v) => String(v).replace(/<[^>]*>/g, ' ')).join(' ').replace(/\s+/g, ' ').trim();
  const title = String(item.titulo).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const tags = sourceTerms(item.tags, item.categoria, item.category, item.tipo, item.classificacao, item.grupo);
  if (item.sucata === true || mentionsScrap(`${title} ${description} ${tags}`) || looksLikePart(`${title} ${description} ${tags}`) || looksLikeCollectible(`${title} ${description} ${tags}`)) return null;
  const cls = classifyInScope(title, tags);
  if (!cls) return null;
  const asset: AssetType = cls.assetType;
  const start = phpDate(auction.dataProximoLeilao);
  const end = currentDeadline(item.dataFechamento, start);
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
    closingModel: 'pregao_em_horario', auctionEndUtc: end, auctionStartUtc: start,
    sourceTz: 'America/Fortaleza', status: lotStatus,
    auctioneerName: campos.nomeDeLeiloeiro(auction.leiloeiro),
    currentBid: money(item.valorAtual), minBid: money(item.valorMinimo) ?? money(item.valorInicial), bidIncrement: money(item.valorIncremento),
    city: campos.localDeTexto(title)?.city ?? null, state: campos.localDeTexto(title)?.uf ?? null,
    photos: [...photos], photoCount: photos.size,
    brand: parsed?.brand ?? null, model: parsed?.model ?? null, version: parsed?.version ?? null,
    yearMake: parsed?.yearMake ?? null, yearModel: parsed?.yearModel ?? null,
    raw: { tenant: normalizedHost, sourceId: item.id, itemId: item.aid, eventId: auction.id, eventAid: auction.aid,
      itemStatus: item.status, eventStatus: auction.statusString, directSale: Boolean(auction.vendaDireta) },
  } as CanonicalLot;
}

/** Laravel event-detail contract: the complete public `var lote = {...}` blob. */
export function parseSuporteDetalhe(html: string, host: string, url: string, sourceCategory?: string | null): CanonicalLot | null {
  const item = jsonVar(html, 'lote');
  if (!item || item.active === false || item.deleted === true || !item.id) return null;
  const stats = jsonVar(html, 'stats') ?? item?.stats ?? item?.leilao?.stats ?? {};
  const estatisticaLote = stats.lote ?? {};
  const bem = estatisticaLote.bem ?? item.bem ?? {};
  const title = String(item.titulo ?? item.descricao ?? bem.siteTitulo ?? bem.descricao ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const description = [item.descricao, item.observacao, bem.descricao, bem.siteDescricao, item.condicao, estatisticaLote.descricao].filter((v) => v != null && String(v).trim()).map((v) => String(v).replace(/<[^>]*>/g, ' ')).join(' ').replace(/\s+/g, ' ').trim();
  const tags = sourceTerms(sourceCategory, item.tags, item.categoria, item.category, item.tipo, item.classificacao, item.grupo,
    bem.categoria, bem.siteCategoria, estatisticaLote.tags, estatisticaLote.categoria);
  if (!title || item.sucata === true || mentionsScrap(`${title} ${description} ${tags}`) || looksLikePart(`${title} ${description} ${tags}`) || looksLikeCollectible(`${title} ${description} ${tags}`)) return null;
  const classified = classifyInScope(title, tags);
  if (!classified) return null;
  const auction = item.leilao ?? {};
  const praca = Math.min(3, Math.max(1, Number(auction.praca) || 1));
  const start = phpDate(auction[`data${praca}`]);
  const end = currentDeadline(item.dataFechamento, start);
  const photos = new Set<string>();
  const $ = cheerio.load(html);
  $('img[src*="/bens/"], a[href*="/bens/"]').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('href');
    if (src) photos.add(new URL(src, `https://${host}`).href);
  });
  const statusMap: Record<number, LotStatus> = { 1: 'aberto' };
  const id = String(item.id);
  return {
    sourceId: 'suporteleiloes', externalId: `${host.replace(/^www\./, '')}:${id}`,
    lotUrl: new URL(url, `https://${host}`).href, titleRaw: title, sourceCategory: tags || null,
    assetType: classified.assetType,
    propertyType: classified.assetType === 'imovel' ? classifyProperty(title, tags) : null,
    vehicleType: classified.assetType === 'veiculo' ? classified.vehicleType : null,
    closingModel: 'pregao_em_horario', auctionStartUtc: start, auctionEndUtc: end,
    sourceTz: 'America/Sao_Paulo', status: statusMap[Number(item.status)] ?? 'sem_data',
    currentBid: Number(item.valorLanceAtual) > 0 ? Number(item.valorLanceAtual) : Number(item.valorAtual) > 0 ? Number(item.valorAtual) : null,
    minBid: Number(item.valorInicial) > 0 ? Number(item.valorInicial) : null,
    bidIncrement: Number(item.valorIncremento) > 0 ? Number(item.valorIncremento) : null,
    appraisal: Number(item.valorAvaliacao) > 0 ? Number(item.valorAvaliacao) : null,
    auctioneerName: campos.nomeDeLeiloeiro(auction.leiloeiro?.nome),
    photos: [...photos], photoCount: photos.size,
    raw: { tenant: host.replace(/^www\./, ''), status: item.status, active: item.active, sucata: item.sucata ?? null, statusString: item.statusString ?? null, sourceTitle: bem.siteTitulo ?? null },
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
