import { fetchText, fetchTenantText } from './http.js';
import * as cheerio from 'cheerio';
import type { Connector, CollectResult, CollectOptions } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart, looksLikeCollectible, classifyAsset, classifyProperty } from '../core/normalize.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';

const MAQUINA_TITULO = /\b(empilhadeira|trator(?:es)?|retroescavadeira|escavadeira|motoniveladora|p[aá]\s*carregadeira|carregadeira|colheitadeira|betoneira|rolo\s*compactador|bobcat)\b/i;

export function classifyLeilotechAsset(title: string, categoria?: string | null): {
  assetType: CanonicalLot['assetType'];
  vehicleType: CanonicalLot['vehicleType'];
  propertyType: CanonicalLot['propertyType'];
} {
  const isImovel = /im[óo]vel|apartamento|casa|sobrado|terreno|sala\s+comercial|barrac[ãa]o|fra[çc][ãa]o\s+ideal|vaga\s+de\s+garagem/i.test(
    `${categoria ?? ''} ${title}`,
  );
  const isMaquina = !isImovel && MAQUINA_TITULO.test(`${categoria ?? ''} ${title}`);
  const parsed = parseTitle(title);
  const isVeiculo = !isImovel && (isMaquina || /ve[íi]culo/i.test(categoria ?? '') || Boolean(parsed.brand));

  const assetType: CanonicalLot['assetType'] = isImovel ? 'imovel' : isVeiculo ? 'veiculo' : 'outro';
  const vehicleType = isMaquina ? 'maquina' : isVeiculo ? (classifyAsset(title).vehicleType ?? 'carro') : null;
  const propertyType = isImovel ? classifyProperty(title, categoria ?? 'imovel') : null;
  return { assetType, vehicleType, propertyType };
}

/**
 * LEILOTECH keeps the discovered-tenant parser; ArremataBem uses a separate
 * public `/agenda` snapshot contract with dedicated lot URLs.
 *
 * A listagem NÃO traz preço nem status por item — só a página de detalhe tem
 * o `<dl>` com Status/Categoria/Avaliação. Com 12 lotes, 1 requisição por
 * lote é barato; não compensaria numa fonte grande.
 *
 * Sem campo de lance (nem "Lance Inicial" nem "Lance Atual") em nenhuma das
 * páginas testadas — só Avaliação. Lance fica null de propósito.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Tenants oficiais achados nos DOCX estaduais e confirmados no contrato
 * Leilotech. Entram fixos porque a descoberta pode não ter rodado ainda — e,
 * se ficarem só no catálogo, uma coleta pequena pode nunca alcançá-los.
 */
const DOCX_LEILOTECH_TENANTS = ['arrematabem.com.br'];

function leiloeiroDoHost(host: string): string {
  return host.replace(/^www\./, '').replace(/\.(com\.br|com|lel\.br|leilao\.br)$/i, '').replace(/leiloes?/gi, ' Leilões ').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (m) => m.toUpperCase());
}

async function tenants(limite: number, tenant?: string, lookup: typeof query = query): Promise<string[]> {
  const rows = await lookup<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='leilotech' AND http_status=200 ORDER BY domain`,
  );
  const candidates = [...new Set([...DOCX_LEILOTECH_TENANTS, ...rows.map((r) => r.domain)])];
  const escolhidos = await dueTenants({ sourceId: 'leilotech', candidates, limit: tenant ? Number.MAX_SAFE_INTEGER : limite, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  if (!tenant) return escolhidos;
  const apenas = filterTenantPopulation(escolhidos, tenant);
  if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de leilotech`);
  return apenas;
}

function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/ativo|aberto/.test(t)) return 'aberto';
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/encerrad|cancelad|suspens/.test(t)) return 'encerrado';
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

export function lerDl(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>([^<]*)<\/dd>/gi)) {
    out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

export function agendaLots(html: string, host: string): Array<{ id: string; slug: string; title: string; url: string }> {
  const $ = cheerio.load(html), base = `https://${host}`, seen = new Set<string>(), out: Array<{ id: string; slug: string; title: string; url: string }> = [];
  $('#v2-app a[href*="/lote/"]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    if (!href) return;
    const url = new URL(href, base);
    if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'arrematabem.com.br') return;
    const match = /^\/lote\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (!match || seen.has(match[1])) return;
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(match[1]);
    out.push({ id: match[1], slug: match[2], title, url: url.href });
  });
  return out;
}

export const leilotech: Connector = {
  def: {
    id: 'leilotech',
    name: 'Plataforma Leilotech',
    platform: 'Leilotech',
    method: 'html',
    tier: 4,
    siteUrl: 'https://topoleiloes.com.br',
    notes: '1 tenant conhecido, catálogo pequeno. Detalhe do lote (não a listagem) tem status/categoria/avaliação num <dl>. Sem campo de lance.',
  },
  async collect(
    { limit, observer, tenant }: CollectOptions,
    io: { fetchText?: typeof fetchText; fetchTenantText?: typeof fetchTenantText; query?: typeof query } = {},
  ): Promise<CollectResult> {
    const fetch = io.fetchText ?? fetchText;
    const fetchTenant = io.fetchTenantText ?? fetchTenantText;
    const dbQuery = io.query ?? query;
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    let arremataPartial = false;

    const dominios = await tenants(Number(process.env.LEILOTECH_TENANTS ?? 5), tenant, dbQuery);

    for (const host of dominios) {
      if (lots.length >= limit) break;
      const attempt = await observer?.start(host);
      const antes = lots.length, fetchedAntes = fetched, skippedAntes = skipped;
      let truncated = false;
      try {
      const normalizedHost = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      const arremata = normalizedHost === 'arrematabem.com.br';
      if (arremata) arremataPartial = true;
      let r;
      try {
        r = arremata
          ? await fetchTenant(`https://${host}/agenda`, normalizedHost, { headers: { 'user-agent': UA }, gapMs: 1100 })
          : await fetch(`https://${host}/agenda`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        attempt?.failure('network');
        continue;
      }
      attempt?.response(r.status);
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const links: Array<{ id: string; slug: string; title: string; url: string }> = arremata
        ? agendaLots(r.body, normalizedHost)
        : (() => {
          const seen = new Set<string>(), found: Array<{ id: string; slug: string; title: string; url: string }> = [];
          for (const m of r.body.matchAll(/href="\/lote\/(\d+)\/([^"]+)"[^>]*>([^<]+)</g)) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            const slug = m[2];
            found.push({ id: m[1], slug, title: m[3].replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim(), url: `https://${host}/lote/${m[1]}/${slug}` });
          }
          return found;
        })();
      fetched += links.length;

      for (const l of links) {
        if (lots.length >= limit) { truncated = true; break; }
        if (!l.title || looksLikePart(l.title) || looksLikeCollectible(l.title) || /\b(pe[cç]as?|partes?|sucatas?)\b/i.test(l.title)) {
          skipped++;
          continue;
        }
        let dr;
        try {
          dr = arremata
            ? await fetchTenant(l.url, normalizedHost, { headers: { 'user-agent': UA }, gapMs: 1100 })
            : await fetch(l.url, { headers: { 'user-agent': UA }, gapMs: 1100 });
        } catch {
          attempt?.failure('network');
          skipped++;
          continue;
        }
        attempt?.response(dr.status);
        if (dr.status !== 200) {
          skipped++;
          continue;
        }
        const dl = lerDl(dr.body);
        const parsed = parseTitle(l.title);
        const local = campos.localDeTexto(l.title);
        const foto = dr.body.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;

        const classification = classifyLeilotechAsset(l.title, dl.categoria);
        lots.push({
          sourceId: 'leilotech',
          externalId: arremata ? `${normalizedHost}:${l.id}` : `${host}:${l.id}`,
          lotUrl: dr.url ?? l.url,
          auctioneerName: leiloeiroDoHost(host),
          titleRaw: l.title,
          brand: classification.assetType === 'imovel' ? null : parsed.brand,
          model: classification.assetType === 'imovel' ? null : parsed.model,
          version: classification.assetType === 'imovel' ? null : parsed.version,
          yearMake: classification.assetType === 'imovel' ? null : parsed.yearMake,
          yearModel: classification.assetType === 'imovel' ? null : parsed.yearModel,
          sourceCategory: dl.categoria ?? null,
          assetType: classification.assetType,
          vehicleType: classification.vehicleType,
          propertyType: classification.propertyType,
          closingModel: 'sequencial',
          auctionStartUtc: null,
          auctionEndUtc: null,
          sourceTz: 'America/Sao_Paulo',
          status: dl.status ? statusDe(dl.status) : 'sem_data',
          appraisal: dinheiro(dl['avaliação']),
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto] : [],
          raw: { tenant: arremata ? normalizedHost : host, dl },
        });
      }
      if (lots.length >= limit) truncated = true;
      if (lots.length >= limit) break;
      } catch (error) {
        attempt?.failure('parser');
        throw error;
      } finally {
        await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
    }
    return {
      lots: lots.slice(0, limit), fetched, skipped, httpStatus,
      note: arremataPartial ? 'cobertura parcial: apenas /agenda; /venda-direta e /encerrados são populações separadas, não incluídas' : undefined,
    };
  },
};
