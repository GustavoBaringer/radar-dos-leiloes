import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import { classifyAsset, classifySeller, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';
import { CollectionCancellationError, throwIfCancelled } from '../core/collection-cancellation.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const PAGINAS = ['/', '/agenda-de-leiloes', '/agenda', '/Agenda.aspx', '/eventos/proximos', '/evento.php', '/leilao', '/lotes-encerrando', '/lotes', '/lotes/imoveis', '/lotes/veiculos'];
const ESCOPO = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|sala|loja|fazenda|rural|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento|sucata/i;
const ESCOPO_ASP = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|fazenda|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento/i;
const FORA_ESCOPO = /numism[aá]tica|filatelia|cart[õo]es?\s+postais|eucalol|brinquedos?|colecion[aá]veis|porcelana|moedas?/i;
const MONITORED_ONLY = ['coliseumleiloes.com.br', 'leiloesbrasilpe.com.br', 'albuquerqueleiloes.com.br', 'ghvmleiloes.com.br', 'portaldosleiloes.com.br'];
const REVIEWED_TENANTS = ['c3leiloes.com.br', 'leiloescostaesilva.com.br', 'tbaracajuleiloes.com.br', ...MONITORED_ONLY];
const BLOCKED = /sistema indispon[ií]vel|acesso negado|access denied|captcha|verifica[cç][aã]o de seguran[cç]a/i;

export function isBlockedPage(body: string): boolean { return BLOCKED.test(texto(body)); }

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
  const $ = cheerio.load(html);
  const h1 = texto($('h1').first().text() || $('title').first().text());
  const reviewedProbe = REVIEWED_TENANTS.includes(host.replace(/^www\./i, '').toLowerCase());
  if (reviewedProbe && status !== 200) return null;
  const titulo = h1 && !/^(início|home)$/i.test(h1) ? h1 : reviewedProbe ? '' : slugTitulo(url);
  const body = texto(html).slice(0, 6000);
  if (!titulo || looksLikePart(titulo) || looksLikeCollectible(titulo) || !ESCOPO.test(reviewedProbe ? titulo : `${titulo} ${body}`)) return null;
  const parsed = parseTitle(titulo);
  const cls = classifyAsset(titulo);
  if (reviewedProbe && cls.assetType === 'outro') return null;
  const local = campos.localDeTexto(`${titulo} ${body}`);
  const preco = dinheiro(body.match(/(?:lance\s*(?:inicial|atual|mínimo|minimo)|avaliaç[aã]o|valor)\D{0,80}(R\$\s*[\d.,]+)/i)?.[1]);
  const id = `${host}:${url.match(/\/(?:lote|lotes|leilao)\/([^/?#]+)/i)?.[1] ?? url.match(/(?:id|cod|evento)=([^&#]+)/i)?.[1] ?? url}`;
  return {
    sourceId: 'htmlagenda', externalId: id, lotUrl: url, titleRaw: titulo,
    brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
    assetType: cls.assetType, vehicleType: cls.vehicleType,
    closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: 'sem_data',
    minBid: preco, currentBid: preco, auctioneerName: host.replace(/^www\./, ''), sellerType: classifySeller(null) as any,
    city: local?.city ?? null, state: local?.uf ?? null, photos: [], raw: { tenant: host, generic: true },
  };
}

type HtmlAgendaFetch = typeof fetchText;

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
      for (const p of PAGINAS) {
        if (lots.length >= limit) { truncated = true; break; }
        throwIfCancelled();
        try {
          const r = await linksDePagina(base, p, attempt);
          if (p === '/' || r.links.length) httpStatus = r.status || httpStatus;
          if (p === '/') {
            homeBody = r.body;
            if (r.status !== 200 || isBlockedPage(r.body)) break;
          }
          r.links.forEach((l) => urls.add(l));
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
    return { lots, fetched, skipped, httpStatus };
  },
};
