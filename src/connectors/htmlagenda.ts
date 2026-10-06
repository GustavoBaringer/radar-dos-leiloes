import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { query } from '../core/db.js';
import { classifyAsset, classifySeller, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const PAGINAS = ['/', '/agenda-de-leiloes', '/agenda', '/lotes-encerrando', '/lotes'];
const ESCOPO = /im[óo]vel|apartamento|casa|terreno|galp[aã]o|sala|loja|fazenda|rural|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento|sucata/i;

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='html-agenda' AND http_status=200 AND has_lots IS NOT FALSE
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
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

async function linksDePagina(base: string, path: string): Promise<{ status: number; links: string[] }> {
  const r = await fetchText(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 900 });
  if (r.status !== 200) return { status: r.status, links: [] };
  const $ = cheerio.load(r.body);
  const links = new Set<string>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (!/\/(lote|lotes|leilao|eventos\/leilao)\//i.test(href)) return;
    const u = absoluta(base, href);
    if (u) links.add(u);
  });
  return { status: r.status, links: [...links] };
}

async function loteDeUrl(host: string, url: string): Promise<CanonicalLot | null> {
  let html = '';
  try {
    const r = await fetchText(url, { headers: { 'user-agent': UA }, gapMs: 900 });
    if (r.status === 200) html = r.body;
  } catch { /* usa slug */ }
  const $ = cheerio.load(html);
  const h1 = texto($('h1').first().text() || $('title').first().text());
  const titulo = h1 && !/^(início|home)$/i.test(h1) ? h1 : slugTitulo(url);
  if (!titulo || looksLikePart(titulo) || !ESCOPO.test(titulo)) return null;
  const parsed = parseTitle(titulo);
  const cls = classifyAsset(titulo);
  const body = texto(html).slice(0, 6000);
  const local = campos.localDeTexto(`${titulo} ${body}`);
  const preco = dinheiro(body.match(/(?:lance\s*(?:inicial|atual|mínimo|minimo)|avaliaç[aã]o|valor)\D{0,80}(R\$\s*[\d.,]+)/i)?.[1]);
  const id = `${host}:${url.match(/\/(?:lote|lotes|leilao)\/([^/?#]+)/i)?.[1] ?? url}`;
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
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0, skipped = 0, httpStatus = 0;
    const dominios = await tenants(Number(process.env.HTMLAGENDA_TENANTS ?? 30));
    for (const host of dominios) {
      const base = `https://${host}`;
      const urls = new Set<string>();
      for (const p of PAGINAS) {
        if (lots.length >= limit) break;
        try {
          const r = await linksDePagina(base, p); httpStatus = r.status || httpStatus;
          r.links.forEach((l) => urls.add(l));
        } catch { /* próximo path */ }
      }
      for (const u of urls) {
        if (lots.length >= limit) break;
        fetched++;
        const lot = await loteDeUrl(host, u);
        if (lot) lots.push(lot); else skipped++;
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
