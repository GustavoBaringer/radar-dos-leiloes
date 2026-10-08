import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import { classifyAsset, classifySeller, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';
import { CollectionCancellationError, throwIfCancelled } from '../core/collection-cancellation.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const PAGINAS = ['/', '/agenda-de-leiloes', '/agenda', '/Agenda.aspx', '/eventos/proximos', '/evento.php', '/leilao', '/lotes-encerrando', '/lotes', '/lotes/imoveis', '/lotes/veiculos'];
const ESCOPO = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|sala|loja|fazenda|rural|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento|sucata/i;

async function tenants(limite: number, tenant?: string): Promise<string[]> {
  const explicitos = String(process.env.HTMLAGENDA_DOMAINS ?? '').trim();
  if (explicitos) {
    const lista = explicitos.split(',').map((d) => d.trim()).filter(Boolean);
    if (!tenant) return lista;
    const apenas = filterTenantPopulation(lista, tenant);
    if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população explícita de HTMLAGENDA_DOMAINS`);
    return apenas;
  }
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='html-agenda' AND http_status=200 AND has_lots IS NOT FALSE
       ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  const escolhidos = await dueTenants({ sourceId: 'htmlagenda', candidates: rows.map((r) => r.domain), limit: tenant ? Number.MAX_SAFE_INTEGER : limite, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  if (!tenant) return escolhidos;
  const apenas = filterTenantPopulation(escolhidos, tenant);
  if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de htmlagenda`);
  return apenas;
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

async function linksDePagina(base: string, path: string, observer?: import('../core/tenant-attempts.js').TenantAttempt): Promise<{ status: number; links: string[] }> {
  let r;
  try {
    r = await fetchText(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 900 });
  } catch (error) {
    // Cancelamento não é falha de rede daquele tenant: o catch externo classifica.
    if (error instanceof CollectionCancellationError) throw error;
    observer?.failure('network');
    throw error;
  }
  observer?.response(r.status);
  if (r.status !== 200) return { status: r.status, links: [] };
  const $ = cheerio.load(r.body);
  const links = new Set<string>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (!/(\/(lote|lotes|leilao|leiloes|eventos\/leilao)\/|evento\.php|agenda\.aspx)/i.test(href)) return;
    const u = absoluta(base, href);
    if (u) links.add(u);
  });
  return { status: r.status, links: [...links] };
}

async function loteDeUrl(host: string, url: string, observer?: import('../core/tenant-attempts.js').TenantAttempt): Promise<CanonicalLot | null> {
  let html = '';
  try {
    const r = await fetchText(url, { headers: { 'user-agent': UA }, gapMs: 900 });
    observer?.response(r.status);
    if (r.status === 200) html = r.body;
  } catch (error) {
    if (error instanceof CollectionCancellationError) throw error;
    observer?.failure('network'); /* usa slug */
  }
  const $ = cheerio.load(html);
  const h1 = texto($('h1').first().text() || $('title').first().text());
  const titulo = h1 && !/^(início|home)$/i.test(h1) ? h1 : slugTitulo(url);
  const body = texto(html).slice(0, 6000);
  if (!titulo || looksLikePart(titulo) || !ESCOPO.test(`${titulo} ${body}`)) return null;
  const parsed = parseTitle(titulo);
  const cls = classifyAsset(titulo);
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
      try {
      const base = `https://${host}`;
      const urls = new Set<string>();
      for (const p of PAGINAS) {
        if (lots.length >= limit) { truncated = true; break; }
        throwIfCancelled();
        try {
          const r = await linksDePagina(base, p, attempt); httpStatus = r.status || httpStatus;
          r.links.forEach((l) => urls.add(l));
        } catch (error) {
          // falha de rede já registrada pela função; cancelamento corta o laço
          if (error instanceof CollectionCancellationError) throw error;
        }
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
        if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
        else attempt?.failure('parser');
        throw error;
      } finally {
        await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
