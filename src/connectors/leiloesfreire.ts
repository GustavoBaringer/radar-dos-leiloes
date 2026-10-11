import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifyAsset, classifyProperty, parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { CollectionCancellationError, throwIfCancelled } from '../core/collection-cancellation.js';

const HOST = 'https://www.leiloesfreire.com.br';
const DOMAIN = 'leiloesfreire.com.br';
const MAX_EVENTOS_ATIVOS = 50;
const MAX_PAGINAS_EVENTO = 20;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface Card {
  id: string;
  title: string;
  photo: string | null;
  statusText: string;
  price: number | null;
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}
function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
export function normalizarTenantFreire(tenant?: string): string | null {
  if (tenant === undefined) return null;
  const host = tenant.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (host !== DOMAIN) throw new Error(`single-tenant '${tenant}' fora da população de leiloesfreire`);
  return DOMAIN;
}
export function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/aguard|agendad/.test(t)) return 'agendado';
  if (/disputa|aberto|lance/.test(t)) return 'aberto';
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/encerrad|cancelad/.test(t)) return 'encerrado';
  return 'sem_data';
}

export function eventosAtivos(html: string): string[] {
  const $ = cheerio.load(html), out = new Set<string>();
  $('article.single_product').each((_, el) => {
    const card = $(el), status = card.find('.leilao_situacao').text().replace(/\s+/g, ' ').trim();
    if (/encerrad|cancelad|suspens|vendid|arrematad|desert/i.test(status) ||
        !/aberto|lance|disputa|aguard|agendad|breve/i.test(status)) return;
    card.find('a[href*="/leilao/"]').each((_, a) => {
      const url = new URL($(a).attr('href') ?? '', HOST);
      const match = /^\/leilao\/(\d+)$/.exec(url.pathname);
      if (url.hostname === new URL(HOST).hostname && match) out.add(`${HOST}/leilao/${match[1]}`);
    });
  });
  return [...out];
}

function paginasReaisEvento(html: string, eventUrl: string): string[] {
  const base = new URL(eventUrl), $ = cheerio.load(html), out = new Set<string>();
  $('a[href*="page="]').each((_, el) => {
    const url = new URL($(el).attr('href') ?? '', base);
    const page = Number(url.searchParams.get('page'));
    if (url.hostname === base.hostname && url.pathname === base.pathname && Number.isInteger(page) && page > 1) out.add(url.href);
  });
  return [...out];
}
export function relancarCancelamento(error: unknown): void {
  if (error instanceof CollectionCancellationError) throw error;
}
export function lerCards(html: string): Card[] {
  const cards: Card[] = [];
  const vistos = new Set<string>();
  for (const m of html.matchAll(/<article class="single_product">([\s\S]*?)<\/article>/g)) {
    const corte = m[1];
    const id = corte.match(/href="https:\/\/www\.leiloesfreire\.com\.br\/leilao\/lote\/(\d+)"/)?.[1];
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    const title = strip(corte.match(/<div class="leilao_titulo">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const statusText = strip(corte.match(/<div class="leilao_situacao[^\"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
    cards.push({
      id,
      title,
      photo: corte.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null,
      statusText,
      price: dinheiro(corte.match(/current_price">\s*R\$\s*([\d.,]+)/)?.[1]),
    });
  }
  return cards;
}
export function mapearLote(card: Card, evento: string, dataEvento: Date | null): CanonicalLot | null {
  if (!card.title || looksLikePart(card.title)) return null;
  const parsed = parseTitle(card.title);
  const propertyType = classifyProperty(card.title);
  const kind = classifyAsset(card.title, propertyType && !parsed.brand ? 'imovel' : null);
  const local = campos.localDeTexto(card.title);
  return {
    sourceId: 'leiloesfreire',
    externalId: card.id,
    lotUrl: `${HOST}/leilao/lote/${card.id}`,
    auctioneerName: 'Leilões Freire',
    titleRaw: card.title,
    brand: kind.assetType === 'veiculo' ? parsed.brand : null,
    model: kind.assetType === 'veiculo' ? parsed.model : null,
    version: kind.assetType === 'veiculo' ? parsed.version : null,
    yearMake: kind.assetType === 'veiculo' ? parsed.yearMake : null,
    yearModel: kind.assetType === 'veiculo' ? parsed.yearModel : null,
    assetType: kind.assetType,
    vehicleType: kind.assetType === 'veiculo' ? kind.vehicleType : null,
    propertyType: kind.assetType === 'imovel' ? propertyType : null,
    closingModel: 'pregao_em_horario',
    auctionStartUtc: dataEvento,
    auctionEndUtc: dataEvento,
    sourceTz: 'America/Sao_Paulo',
    status: statusDe(card.statusText),
    minBid: card.price,
    sellerType: classifySeller(null) as any,
    city: local?.city ?? null,
    state: local?.uf ?? null,
    photos: card.photo ? [card.photo] : [],
    raw: { evento, statusTexto: card.statusText },
  };
}

export async function collectLeiloesFreire({ limit, tenant, observer }: Parameters<Connector['collect']>[0], request: typeof fetchText = fetchText): Promise<CollectResult> {
    normalizarTenantFreire(tenant);
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0, skipped = 0, httpStatus = 0, truncated = false;
    const attempt = await observer?.start(DOMAIN);
    try {
      let home;
      try {
        throwIfCancelled();
        home = await request(`${HOST}/leiloes`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        throwIfCancelled();
      } catch (error) {
        throwIfCancelled();
        relancarCancelamento(error);
        attempt?.failure('network');
        return { lots, fetched, skipped, httpStatus };
      }
      attempt?.response(home.status);
      httpStatus = home.status;
      if (home.status !== 200) return { lots, fetched, skipped, httpStatus };

      const todosEventos = eventosAtivos(home.body);
      const eventos = todosEventos.slice(0, MAX_EVENTOS_ATIVOS);
      truncated = todosEventos.length > eventos.length;
      for (const eventUrl of eventos) {
        throwIfCancelled();
        if (lots.length >= limit) { truncated = true; break; }
        const ev = /\/leilao\/(\d+)$/.exec(eventUrl)?.[1] ?? '';
        const pages = [eventUrl], pagesSeen = new Set<string>(), signatures = new Set<string>();
        let dataEvento: Date | null = null;
        while (pages.length && pagesSeen.size < MAX_PAGINAS_EVENTO) {
          throwIfCancelled();
          const url = pages.shift()!;
          if (pagesSeen.has(url)) continue;
          pagesSeen.add(url);
          let r;
          try {
            r = await request(url, { headers: { 'user-agent': UA }, gapMs: 1100 });
            throwIfCancelled();
          } catch (error) {
            throwIfCancelled();
            relancarCancelamento(error);
            attempt?.failure('network');
            continue;
          }
          attempt?.response(r.status);
          httpStatus = r.status;
          if (r.status !== 200) continue;
          dataEvento ??= dataBr(r.body.match(/\d{2}\/\d{2}\/\d{4}\s+às\s+\d{2}:\d{2}/)?.[0]);
          const cards = lerCards(r.body), signature = cards.map((card) => card.id).join(',');
          const nextPages = paginasReaisEvento(r.body, eventUrl);
          if (signature && signatures.has(signature)) {
            if (nextPages.some((next) => !pagesSeen.has(next))) truncated = true;
            break;
          }
          if (signature) signatures.add(signature);
          for (const card of cards) {
            throwIfCancelled();
            if (lots.length >= limit) { truncated = true; break; }
            if (vistos.has(card.id)) continue;
            vistos.add(card.id);
            fetched++;
            const lot = mapearLote(card, ev, dataEvento);
            if (!lot) { skipped++; continue; }
            lots.push(lot);
          }
          for (const next of nextPages) if (!pagesSeen.has(next)) pages.push(next);
        }
        if (pages.length) truncated = true;
      }
      return { lots, fetched, skipped, httpStatus };
    } catch (error) {
      if (error instanceof CollectionCancellationError) {
        attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
      } else {
        attempt?.failure('parser');
      }
      throw error;
    } finally {
      await attempt?.finish({ fetched, skipped, returned: lots.length, truncated });
    }
}

export const leiloesfreire: Connector = {
  def: {
    id: 'leiloesfreire',
    name: 'Leilões Freire',
    platform: 'Leilões Freire Laravel',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Listagem /leiloes aponta eventos ativos; página de evento traz cards com foto, título, preço e status.',
  },
  collect: collectLeiloesFreire,
};
