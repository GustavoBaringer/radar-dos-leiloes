import * as cheerio from 'cheerio';
import { fetchText, fetchTenantText, TenantScopeError, type FetchResult } from './http.js';
import type { CollectOptions, Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifyAsset, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import type { TenantAttempt } from '../core/tenant-attempts.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

/**
 * LEILOAR — plataforma white-label (CakePHP), N leiloeiros por 1 conector.
 * MEDIDO em 22/09: 20 domínios descobertos, 14 responderam lote na sonda.
 *
 * Dois formatos de instalação no mesmo software: alguns tenants publicam na
 * raiz (`/bens/pesquisaAvancada`), outros num subdiretório (`/externo/...`) —
 * detectado por tentativa e cacheado por host.
 *
 * A busca é POST form-urlencoded com `data[Bem][termo]=` vazio; sem o
 * Content-Type certo o servidor devolve 0 resultados mesmo tendo lote (medido
 * contra adringleiloes). Paginação é segmento de path (`/pesquisaAvancada/page:N`),
 * não query string.
 *
 * Débito conhecido: o título no card vem TRUNCADO (a fonte corta e não expõe o
 * texto inteiro fora da página de detalhe) — marca/modelo/ano falha em títulos
 * longos. Buscar o detalhe de cada lote dobraria o tráfego; fica para quando o
 * volume justificar.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const POR_PAGINA = 10;
const CAKE_TENANTS = new Set(['leiloesfederal.com.br', 'prosperarleiloes.com.br']);

function leiloeiroDoHost(host: string): string {
  return host.replace(/^www\./, '').replace(/\.(com\.br|com|lel\.br|leilao\.br)$/i, '').replace(/leiloes?/gi, ' Leilões ').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (m) => m.toUpperCase());
}

async function tenants(limite: number, tenant?: string, execute: typeof query = query): Promise<string[]> {
  const rows = await execute<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='leiloar' AND http_status=200 AND has_lots IS NOT FALSE
       ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  const escolhidos = await dueTenants({ sourceId: 'leiloar', candidates: rows.map((r) => r.domain), limit: tenant ? Number.MAX_SAFE_INTEGER : limite, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  if (!tenant) return escolhidos;
  const apenas = filterTenantPopulation(escolhidos, tenant);
  if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de leiloar`);
  return apenas;
}

const baseConhecida = new Map<string, string>();
/**
 * Tenta raiz, cai pro subdiretório /externo — cacheado por host pro resto da
 * coleta. Aceita por STATUS, não por achar "Exibindo": tenant sem lote no
 * momento devolve 200 sem esse texto, e exigir o texto fazia cair sempre pro
 * `''` padrão mesmo quando a raiz dava 404 e o /externo respondia certo —
 * 12 dos 20 tenants ficavam de fora por isso (medido em 22/09).
 */
async function base(host: string, observer?: TenantAttempt, fetch = fetchText): Promise<string> {
  const conhecida = baseConhecida.get(host);
  if (conhecida != null) return conhecida;
  for (const b of ['', '/externo']) {
    try {
      const r = await fetch(`https://${host}${b}/bens/pesquisaAvancada`, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data[Bem][termo]=',
        gapMs: 1100,
      });
      observer?.response(r.status);
      if (r.status === 200) {
        baseConhecida.set(host, b);
        return b;
      }
    } catch {
      observer?.failure('network');
      /* tenta o próximo formato */
    }
  }
  baseConhecida.set(host, '');
  return '';
}

function statusDe(badges: string[]): LotStatus {
  const t = badges.join(' ').toUpperCase();
  if (/VENDID|ARREMATAD|COMPREI/.test(t)) return 'vendido';
  if (/ENCERRAD|CANCELAD|SUSPENS/.test(t)) return 'encerrado';
  if (/ABERTO/.test(t)) return 'aberto';
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

type NasarCard = { id: string; url: string; title: string; category: string | null; status: LotStatus; appraisal: number | null; minBid: number | null; currentBid: number | null; saleValue: number | null; photo: string | null };

/** Markup from the observed public Nasar event pages, not the empty POST search response. */
function mesmoHost(a: string, b: string): boolean {
  const normalized = (v: string) => v.toLowerCase().replace(/^www\./, '');
  return normalized(a) === normalized(b);
}

export function parseNasarCards(html: string, pageUrl: string): NasarCard[] {
  const $ = cheerio.load(html);
  const out: NasarCard[] = [];
  $('.card-bem').each((_, el) => {
    const card = $(el);
    const href = card.find('a[href*="/lote/"]').first().attr('href') ?? '';
    let url: URL;
    try { url = new URL(href, pageUrl); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || !mesmoHost(url.hostname, new URL(pageUrl).hostname)) return;
    const id = /^\/externo\/lote\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    const title = card.find('.card-bem-descricao').first().text().replace(/\s+/g, ' ').trim();
    if (!id || !title) return;
    const category = card.find('.card-bem-img-footer p').first().text().replace(/\s*\/$/, '').trim() || null;
    const price = (label: RegExp) => {
      const node = card.find('.bem-status-info .col-6').filter((_, n) => label.test($(n).text())).first();
      return dinheiro(node.next('.col-6').text());
    };
    const statusText = card.find('.leilao-status span').first().text().trim();
    const photo = card.find('.card-bem-img').first().attr('src') ?? null;
    out.push({
      id, url: url.toString(), title, category,
      status: /vendid|arrematad|comprei/i.test(statusText) ? 'vendido' : /encerrad|cancelad|suspens/i.test(statusText) ? 'encerrado' : /aberto/i.test(statusText) ? 'aberto' : 'sem_data',
      appraisal: price(/valor de avalia[cç][ãa]o/i), minBid: price(/lance m[ií]nimo/i), currentBid: price(/lance atual/i), saleValue: price(/valor de venda/i),
      photo: photo && !/no-image/i.test(photo) ? new URL(photo, pageUrl).toString() : null,
    });
  });
  return out;
}

export function nasarLocal(title: string): { city: string; uf: string } | null {
  const places = [...title.matchAll(/(?:,\s*|\bem\s+)([A-Za-zÀ-ú][^,\/]{2,35})\/([A-Z]{2})(?=\b|[,.;]|$)/g)];
  const last = places.at(-1);
  if (!last || !campos.ehUf(last[2])) return null;
  const city = campos.caixaDeTitulo(last[1].trim());
  return city ? { city, uf: last[2] } : null;
}

export function nasarDate(html: string): { date: Date | null; sourceTz: string; rawDate: string | null; suspiciousFuture: boolean } {
  const $ = cheerio.load(html);
  const rawDate = $('#conteudo').text().match(/Data\s+(\d{2}\/\d{2}\/\d{4})\s+às\s+(\d{2}:\d{2}:\d{2})/i);
  const sourceTz = /FORTALEZA/i.test($('#conteudo').text()) ? 'America/Fortaleza' : 'America/Sao_Paulo';
  if (!rawDate) return { date: null, sourceTz, rawDate: null, suspiciousFuture: false };
  const [, d, t] = rawDate;
  const [day, month, year] = d.split('/').map(Number), [hour, minute, second] = t.split(':').map(Number);
  // Both observed venues are UTC-03; the original date text is retained as provenance.
  const date = new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second));
  // Source dates over ten years ahead are retained, but flagged for review.
  return { date, sourceTz, rawDate: `${d} ${t}`, suspiciousFuture: year > new Date().getFullYear() + 10 };
}

type CakeCard = { id: string; url: string; title: string; category: string | null; status: LotStatus; appraisal: number | null; minBid: number | null; date: Date | null; city: string | null; state: string | null; photo: string | null; machine: boolean };

const cakeDate = (text: string): Date | null => {
  const matches = [...text.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})(?::(\d{2}))?/gi)];
  const m = matches.at(-1);
  if (!m) return null;
  const [, d, month, year, hour, minute, second = '0'] = m;
  const value = Date.parse(`${year}-${month}-${d}T${hour}:${minute}:${second}-03:00`);
  return Number.isFinite(value) ? new Date(value) : null;
};

const cakeMoney = (text: string, label: RegExp): number | null => {
  const m = label.exec(text);
  return m ? dinheiro(m[1]) : null;
};

/** Parser for the observed public CakePHP `.card-bem` listings of Federal and Prosperar. */
export function parseCakeCards(html: string, pageUrl: string): CakeCard[] {
  const $ = cheerio.load(html);
  const pageHost = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  const cards: CakeCard[] = [];
  $('.card-bem').each((_, el) => {
    const card = $(el);
    const href = card.find('a[href*="/lote/"]').first().attr('href');
    if (!href) return;
    let url: URL;
    try { url = new URL(href, pageUrl); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.toLowerCase().replace(/^www\./, '') !== pageHost) return;
    const id = /\/lote\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (!id || cards.some((item) => item.id === id)) return;
    const description = card.find('.card-bem-descricao').first();
    const firstLine = (description.text().trim().split(/\n+/)[0] ?? '').replace(/\s+/g, ' ').trim();
    const localText = card.find('#bem-local').first().text().replace(/\s+/g, ' ').trim();
    const title = ((pageHost === 'leiloesfederal.com.br' ? firstLine || localText : card.find('.card-bem-leilao p').first().text().trim()) || firstLine).replace(/\s+/g, ' ');
    if (!title) return;
    const text = card.text().replace(/\s+/g, ' ').trim();
    const pageText = $('body').text().replace(/\s+/g, ' ').trim();
    const statusText = card.find('.leilao-status').text().trim().toLowerCase();
    const status: LotStatus = /vendid|arrematad/.test(statusText) ? 'vendido'
      : /suspens|cancelad|encerrad/.test(statusText) ? 'encerrado'
        : /aberto/.test(statusText) ? 'aberto' : 'sem_data';
    const category = card.find('.card-bem-img-footer p').first().text().replace(/\s+/g, ' ').trim() || null;
    const categoryText = category ?? '';
    const machine = /compressor de refrigera[cç][ãa]o industrial/i.test(`${title} ${text}`);
    const local = campos.localDeTexto(title) ?? campos.localDeTexto(localText);
    cards.push({
      id, url: url.href, title, category,
      status,
      appraisal: cakeMoney(text, /Avalia[cç][ãa]o\s*:?\s*R\$\s*([\d.]+,\d{2})/i),
      minBid: cakeMoney(text, /Lance\s*(?:Inicial|M[ií]nimo)\s*:?\s*R\$\s*([\d.]+,\d{2})/i),
      date: cakeDate(text) ?? cakeDate(pageText),
      city: local?.city ?? null, state: local?.uf ?? null,
      photo: card.find('img.card-bem-img').first().attr('src') ?? null,
      machine: machine && /compressor|industrial|diversos/i.test(categoryText + ' ' + title),
    });
  });
  return cards;
}

export async function collectCakeTenant(host: string, limit: number, request: (url: string, tenant: string) => Promise<FetchResult & { url: string }> = fetchTenantText as any, observer?: TenantAttempt): Promise<CollectResult> {
  const normalized = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!CAKE_TENANTS.has(normalized)) throw new Error(`tenant CakePHP não revisado: ${host}`);
  const lots: CanonicalLot[] = [], seen = new Set<string>(), notes: string[] = [];
  let fetched = 0, skipped = 0, httpStatus = 0;
  const path = normalized === 'prosperarleiloes.com.br' ? '/externo/' : '/';
  const get = async (url: string) => {
    throwIfCancelled();
    const response = await request(url, normalized);
    const finalUrl = new URL(response.url);
    if (finalUrl.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') !== normalized) throw new TenantScopeError(`redirect fora do tenant: ${url} -> ${response.url}`);
    observer?.response(response.status);
    httpStatus = response.status;
    if (response.status !== 200) throw new Error(`${response.status} ${response.url}`);
    return { ...response, url: response.url };
  };
  try {
    const home = await get(`https://${host}${path}`);
    const pages: Array<{ url: string; body: string }> = [];
    if (normalized === 'leiloesfederal.com.br') {
      const $home = cheerio.load(home.body);
      const events = [...new Set($home('a[href]').map((_, a) => {
        const href = $home(a).attr('href');
        if (!href) return null;
        const link = new URL(href, home.url);
        return link.hostname.toLowerCase().replace(/^www\./, '') === normalized && /^\/leilao\/\d+(?:\/|$)/.test(link.pathname) ? link.href : null;
      }).get().filter((item): item is string => item != null))];
      for (const event of events) {
        if (lots.length >= limit) break;
        const result = await get(event);
        pages.push({ url: result.url, body: result.body });
      }
      pages.push({ url: home.url, body: home.body });
    } else pages.push({ url: home.url, body: home.body });

    for (const page of pages) {
      throwIfCancelled();
      for (const card of parseCakeCards(page.body, page.url)) {
        fetched++;
        if (seen.has(card.id)) { skipped++; continue; }
        seen.add(card.id);
        if (lots.length >= limit || looksLikePart(card.title)) { skipped++; continue; }
        const classified = classifyAsset(card.title, card.category ?? '');
        const assetType = card.machine ? 'veiculo' : classified.assetType;
        if (assetType === 'outro') { skipped++; continue; }
        const parsed = parseTitle(card.title);
        const propertyType = /pr[eé]dio\s+comercial|im[oó]vel\s+comercial|galp[aã]o|sala\s+comercial/i.test(`${card.title} ${card.category}`) ? 'comercial'
          : /apartamento/i.test(`${card.title} ${card.category}`) ? 'apartamento'
            : /casa|sobrado/i.test(card.title) ? 'casa'
            : /terreno|gleba|loteamento/i.test(card.title) ? 'terreno'
              : /fazenda|s[ií]tio|ch[aá]cara|rural/i.test(card.title) ? 'rural'
                : undefined;
        lots.push({
          sourceId: 'leiloar', externalId: `${normalized}:${card.id}`, lotUrl: card.url,
          auctioneerName: leiloeiroDoHost(normalized), titleRaw: card.title,
          brand: parsed.brand, model: parsed.model, version: parsed.version,
          yearMake: parsed.yearMake, yearModel: parsed.yearModel,
          sourceCategory: card.category, assetType,
          vehicleType: card.machine ? 'maquina' : classified.vehicleType,
          propertyType,
          closingModel: 'pregao_em_horario', auctionStartUtc: null, auctionEndUtc: card.date,
          sourceTz: 'America/Sao_Paulo', status: card.status,
          minBid: card.minBid, appraisal: card.appraisal,
          sellerType: classifySeller(null) as any, city: card.city, state: card.state,
          photos: card.photo ? [new URL(card.photo, page.url).href] : [],
          raw: { tenant: normalized, cakeListing: page.url },
        });
      }
    }
    if (normalized === 'prosperarleiloes.com.br') notes.push('denominador do catálogo não publicado; cobertura parcial');
    else notes.push('catálogo parcial: apenas home pública e eventos nela vinculados; total geral não observado');
    return { lots, fetched, skipped, httpStatus, note: notes.length ? notes.join('; ') : undefined };
  } catch (error) {
    if (error instanceof CollectionCancellationError || error instanceof TenantScopeError) throw error;
    observer?.failure('network');
    return { lots, fetched, skipped, httpStatus, note: `catálogo parcial: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function collectNasar(host: string, limit: number, observer?: import('../core/tenant-attempts.js').TenantAttempt, fetch = fetchText): Promise<CollectResult> {
  const origin = `https://${host}`;
  const partialReasons = new Set<string>();
  let root;
  try { root = await fetch(`${origin}/externo/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); }
  catch (error) { throwIfCancelled(); observer?.failure('network'); return { lots: [], fetched: 0, skipped: 0, httpStatus: 0, note: `${host}: home network failure` }; }
  observer?.response(root.status);
  if (root.status !== 200) return { lots: [], fetched: 0, skipped: 0, httpStatus: root.status, note: `${host}: home HTTP ${root.status}` };
  const $root = cheerio.load(root.body);
  const events = [...new Set($root('.card-leilao a[href*="/externo/leilao/"]').map((_, a) => {
    const link = $root(a).attr('href');
    if (!link) return null;
    let url: URL;
    try { url = new URL(link, origin); } catch { return null; }
    return /^https?:$/.test(url.protocol) && mesmoHost(url.hostname, new URL(origin).hostname) && /^\/externo\/leilao\/\d+(?:\/|$)/.test(url.pathname) ? url.toString() : null;
  }).get().filter((url): url is string => url != null))];
  const lots: CanonicalLot[] = [];
  const seen = new Set<string>();
  let fetched = 0, skipped = 0, httpStatus = root.status;
  if (!events.length) partialReasons.add(`${host}: no observed public events`);
  let completedEvents = 0;
  for (const [eventIndex, eventUrl] of events.entries()) {
    if (lots.length >= limit) break;
    throwIfCancelled();
    let response;
    try { response = await fetch(eventUrl, { headers: { 'user-agent': UA }, gapMs: 1100 }); }
    catch {
      throwIfCancelled();
      observer?.failure('network');
      partialReasons.add(`${eventUrl}: network failure`);
      completedEvents++;
      continue;
    }
    httpStatus = response.status;
    observer?.response(response.status);
    if (response.status !== 200) { partialReasons.add(`${eventUrl}: HTTP ${response.status}`); completedEvents++; continue; }
    const eventId = /\/leilao\/(\d+)/.exec(new URL(eventUrl).pathname)?.[1] ?? '';
    const event = cheerio.load(response.body);
    const eventTitle = event('#conteudo').text().replace(/\s+/g, ' ').trim();
    const { date, sourceTz, rawDate, suspiciousFuture } = nasarDate(response.body);
    const eventLocation = eventTitle.match(/LOCAL:\s*(.+?)\s*-\s*([A-Z]{2})\b/i);
    const eventCity = eventLocation?.[1] ?? null, eventState = eventLocation?.[2]?.toUpperCase() ?? null;
    let cards: NasarCard[];
    try { cards = parseNasarCards(response.body, eventUrl); }
    catch {
      observer?.failure('parser');
      partialReasons.add(`${eventUrl}: parser failure`);
      completedEvents = eventIndex + 1;
      continue;
    }
    if (!cards.length) { observer?.failure('parser'); partialReasons.add(`${eventUrl}: no cards parsed`); }
    for (const card of cards) {
      fetched++;
      if (seen.has(card.id)) { skipped++; continue; }
      seen.add(card.id);
      if (lots.length >= limit || looksLikePart(card.title)) { skipped++; continue; }
      const category = card.category ?? '';
      const classified = classifyAsset(card.title, category);
      const isMachine = /m[aá]quinas|equip\./i.test(category) && /ponte|trator|escavadeira|empilhadeira|guindaste|rolante/i.test(card.title);
      const assetType = isMachine ? 'veiculo' : classified.assetType;
      if (assetType === 'outro') { skipped++; continue; }
      const parsed = parseTitle(card.title);
      const local = nasarLocal(card.title);
      lots.push({ sourceId: 'leiloar', externalId: `${host}:${card.id}`, lotUrl: card.url, auctioneerName: leiloeiroDoHost(host), titleRaw: card.title,
        brand: parsed.brand, model: parsed.model, version: parsed.version, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
        sourceCategory: category || null, vehicleType: isMachine ? 'maquina' : classified.vehicleType, assetType,
        docType: /judicial/i.test(eventTitle) ? 'judicial' : null, closingModel: 'pregao_em_horario', auctionStartUtc: date, auctionEndUtc: null, sourceTz,
        status: card.status, currentBid: card.currentBid, minBid: card.minBid, appraisal: card.appraisal,
        sellerType: classifySeller(null) as any, city: local?.city ?? null, state: local?.uf ?? null, photos: card.photo ? [card.photo] : [],
        raw: { tenant: host, eventId, eventTitle, eventCity, eventState, eventDateSource: rawDate, eventDateSuspiciousFuture: suspiciousFuture, saleValue: card.saleValue, category },
      });
    }
    completedEvents = eventIndex + 1;
  }
  if (completedEvents < events.length && lots.length >= limit) partialReasons.add(`${host}: listed events unvisited at budget`);
  return { lots, fetched, skipped, httpStatus, note: partialReasons.size ? [...partialReasons].join('; ') : undefined };
}

interface Card {
  id: string;
  url: string;
  titulo: string;
  foto: string | null;
  badges: string[];
  avaliacao: number | null;
  lance: number | null;
  rotuloLance: string | null;
  cidade: string | null;
  uf: string | null;
}

function lerCards($: cheerio.CheerioAPI, baseUrl: string): Card[] {
  const out: Card[] = [];
  $('.bem-card').each((_, el) => {
    const $c = $(el);
    const $link = $c.find('.bem-card-descricao a, a.bem-card-descricao').first();
    const href = $link.attr('href') ?? '';
    const m = href.match(/\/lote\/(\d+)/);
    if (!m) return;
    const localTxt = $c.find('.bem-card-localizacao').first().text().replace(/\s+/g, ' ').trim();
    const [cidade, uf] = localTxt.split(',').map((s) => s.trim());
    const foto = $c.find('.bem-card-foto').attr('src') ?? null;
    out.push({
      id: m[1],
      url: href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`,
      titulo: $link.text().replace(/\s+/g, ' ').trim(),
      foto: foto && !/no-image/i.test(foto) ? (foto.startsWith('http') ? foto : `${baseUrl}/${foto.replace(/^\//, '')}`) : null,
      badges: $c.find('.bem-card-status .badge').map((_, b) => $(b).text().trim()).get(),
      avaliacao: dinheiro($c.find('.bem-card-avaliacao h5').first().text()),
      lance: dinheiro($c.find('.bem-card-lance h4').first().text()),
      rotuloLance: $c.find('.bem-card-lance span').first().text().trim() || null,
      cidade: cidade || null,
      uf: uf && campos.ehUf(uf) ? uf.toUpperCase() : null,
    });
  });
  return out;
}

export async function collectLeiloar(
  { limit, observer, tenant }: CollectOptions,
  io: { fetchText: typeof fetchText; query: typeof query; domains?: string[] } = { fetchText, query },
): Promise<CollectResult> {
    const fetch = io.fetchText, lookup = io.query;
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    const partialReasons = new Set<string>();

    const dominios = io.domains ?? await tenants(Number(process.env.LEILOAR_TENANTS ?? 20), tenant, lookup);
    const cota = Math.max(POR_PAGINA, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      if (lots.length >= limit) break;
      const attempt = await observer?.start(host);
      const antes = lots.length, fetchedAntes = fetched, skippedAntes = skipped;
      let truncated = false;
      if (CAKE_TENANTS.has(host.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))) {
        let result: CollectResult | undefined;
        try {
          result = await collectCakeTenant(host, limit - lots.length, fetchTenantText as any, attempt);
          lots.push(...result.lots);
          fetched += result.fetched;
          skipped += result.skipped;
          httpStatus = result.httpStatus ?? httpStatus;
          if (result.note) partialReasons.add(result.note);
          truncated = result.lots.length >= limit - antes;
        } finally {
          await attempt?.finish({ fetched: result?.fetched ?? 0, skipped: result?.skipped ?? 0, returned: result?.lots.length ?? 0, truncated });
        }
        continue;
      }
      if (host === 'nasarleiloes.com.br') {
        let result: CollectResult | undefined;
        const remainingTenant = Math.max(0, Math.min(limit - lots.length, cota - (lots.length - antes)));
        try {
          result = await collectNasar(host, remainingTenant, attempt, fetch);
          lots.push(...result.lots.slice(0, remainingTenant));
          fetched += result.fetched;
          skipped += result.skipped;
          httpStatus = result.httpStatus ?? httpStatus;
          if (result.note) partialReasons.add(result.note);
        } finally {
          await attempt?.finish({ fetched: result?.fetched ?? 0, skipped: result?.skipped ?? 0, returned: result?.lots.length ?? 0, truncated: remainingTenant > 0 && (result?.lots.length ?? 0) >= remainingTenant });
        }
        continue;
      }
      try {
      const b = await base(host, attempt, fetch);
      const baseUrl = `https://${host}${b}`;
      const antes = lots.length;
      let totalAnunciado: number | null = null;
      let naturalEnd = false;

      for (let pagina = 1; lots.length - antes < cota && lots.length < limit; pagina++) {
        const url = pagina === 1 ? `${baseUrl}/bens/pesquisaAvancada` : `${baseUrl}/bens/pesquisaAvancada/page:${pagina}`;
        let r;
        try {
          r = await fetch(url, {
            method: 'POST',
            headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'data[Bem][termo]=',
            gapMs: 1100,
          });
        } catch {
          attempt?.failure('network');
          break;
        }
        attempt?.response(r.status);
        httpStatus = r.status;
        if (r.status !== 200) break;

        totalAnunciado ??= Number(r.body.match(/Exibindo\s+\d+\s+de\s+(\d+)\s+resultados/i)?.[1]) || 0;
        let cards: Card[];
        try {
          const $ = cheerio.load(r.body);
          cards = lerCards($, baseUrl);
        } catch (error) {
          attempt?.failure('parser');
          throw error;
        }
        if (!cards.length) { naturalEnd = true; break; }
        fetched += cards.length;

        for (const c of cards) {
          if (!c.titulo || looksLikePart(c.titulo)) {
            skipped++;
            continue;
          }
          const parsed = parseTitle(c.titulo);
          const local = c.cidade && c.uf ? { city: campos.apararCidade(c.cidade), uf: c.uf } : campos.localDeTexto(c.titulo);
          const maiorLance = /atual|maior/i.test(c.rotuloLance ?? '');

          lots.push({
            sourceId: 'leiloar',
            externalId: `${host}:${c.id}`,
            lotUrl: c.url,
            auctioneerName: leiloeiroDoHost(host),
            titleRaw: c.titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            docType: /judicial/i.test(c.titulo) ? 'judicial' : null,
            // Sem categoria própria no card — o único badge de "tipo" é
            // "Eletrônico" (modalidade do leilão, igual em veículo e imóvel).
            // O título é o que sobra: termos de imóvel MEDIDOS no oaleiloes
            // (vaga, subloja, quadra, loteamento — "lote" sozinho é ambíguo com
            // número de lote do próprio leilão, por isso não entra na lista).
            assetType: /apartamento|casa|terreno|im[óo]vel|sala|galp[ãa]o|fazenda|s[íi]tio|ch[áa]cara|cobertura|sobrado|vaga\s+de\s+garagem|subloja|quadra|loteamento|gleba/i.test(c.titulo)
              ? 'imovel'
              : 'veiculo',
            // Praça judicial com data e hora fixa (1ª/2ª praça no mesmo dia,
            // 30 min de intervalo — CPC 891) — nunca timer por lote.
            closingModel: 'pregao_em_horario',
            auctionStartUtc: null,
            auctionEndUtc: null,
            sourceTz: 'America/Sao_Paulo',
            status: statusDe(c.badges),
            currentBid: maiorLance ? c.lance : null,
            minBid: maiorLance ? null : c.lance,
            appraisal: c.avaliacao,
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: c.foto ? [c.foto] : [],
            raw: { tenant: host, totalAnunciado, badges: c.badges },
          });
        }
      if (totalAnunciado != null && lots.length - antes >= totalAnunciado) { naturalEnd = true; break; }
      if (cards.length < POR_PAGINA) { naturalEnd = true; break; }
      }
      if (totalAnunciado != null && lots.length - antes < totalAnunciado) {
        partialReasons.add(`${host}: catálogo parcial (${lots.length - antes} de ${totalAnunciado} resultados anunciados observados)`);
      }
      if (!naturalEnd && (lots.length >= limit || lots.length - antes >= cota)) truncated = true;
      } catch (error) {
        attempt?.failure('parser');
        throw error;
      } finally {
        await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus, note: partialReasons.size ? [...partialReasons].join('; ') : undefined };
}

export const leiloar: Connector = {
  def: {
    id: 'leiloar',
    name: 'Plataforma Leiloar',
    platform: 'Leiloar',
    method: 'html',
    tier: 3,
    siteUrl: 'https://plataformaleiloar.com.br',
    notes: 'White-label multi-tenant (CakePHP). POST form-urlencoded em /bens/pesquisaAvancada (raiz ou /externo); paginação por /page:N no path da URL.',
  },
  collect: collectLeiloar,
};
