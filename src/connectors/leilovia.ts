import { fetchText, fetchTenantText, TenantScopeError } from './http.js';
import type { Connector, CollectOptions, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';
import { filterTenantPopulation } from './tenant-scheduler.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

/**
 * LEILOVIA — plataforma white-label ASP.NET, achada em 22/09 a partir de 3
 * leiloeiros oficiais sem conector. Domínio curado, não via `discovered_sites`:
 * a sonda genérica nunca reconheceu essa plataforma (regex por palavra-chave
 * não bate — a home dos 3 é só institucional, o catálogo fica em `/leiloes.aspx`).
 *
 * `rpleiloes.com.br` entra na lista mesmo com 0 lote hoje (só tem 1 leilão-
 * simulador de teste): é a mesma plataforma, e ligar depois que tiver
 * inventário real custa zero — o parser já serve.
 *
 * O card da listagem já tem TUDO — título, categoria, cidade, status, preço —
 * sem precisar da página de detalhe. Preço vem em DOIS `<span>` no mesmo
 * bloco ("Lance atual" e "Lance inicial"), um deles `style="display: none"`;
 * só o `display: block` é o valor real mostrado ao usuário.
 *
 * Data de encerramento é do LEILÃO, não do lote — leilão judicial fecha em
 * sequência, e a página não expõe hora por lote na listagem (só no detalhe,
 * que custaria 1 requisição a mais por lote). "Encerramento previsto" vale
 * pra todos os lotes daquele leilão.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DOMINIOS_BASE = ['vialeiloes.com.br', 'reginaaudeleiloes.com.br', 'rpleiloes.com.br'];

async function tenants(limite: number, tenant?: string, lookup: typeof query = query): Promise<string[]> {
  const rows = await lookup<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE (platform = 'leilovia' OR domain = ANY($2::text[]))
        AND http_status = 200
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain
      LIMIT $1`,
    [tenant ? Number.MAX_SAFE_INTEGER : limite, DOMINIOS_BASE],
  );
  const candidates = [...new Set([...DOMINIOS_BASE, ...rows.map((r) => r.domain)])];
  if (!tenant) return candidates;
  const only = filterTenantPopulation(candidates, tenant);
  if (!only.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de leilovia`);
  return only;
}

function leiloeiroDoHost(host: string): string {
  const mapa: Record<string, string> = {
    'vialeiloes.com.br': 'Via Leilões',
    'reginaaudeleiloes.com.br': 'Regina Aude Leilões',
    'rpleiloes.com.br': 'RP Leilões',
    'hcleiloes.com.br': 'HC Leilões',
    'leiloesonlinems.com.br': 'Leilões Online MS',
  };
  return mapa[host] ?? host.replace(/^www\./, '').replace(/\.(com\.br|com)$/i, '').replace(/leiloes/gi, ' Leilões ').replace(/\s+/g, ' ').trim();
}

function statusDe(v: string): LotStatus {
  if (/em andamento|em leil[ãa]o/i.test(v)) return 'aberto';
  if (/loteament/i.test(v)) return 'agendado';
  // "SUSPENSO POR ORDEM JUDICIAL" / "A RESTITUIR POR DETERMINAÇÃO JUDICIAL":
  // não recebe lance agora, mas nada garante que não volta — mesmo cuidado
  // do "sem_licitante" do soleon. Fica sem_data; o relógio fecha quando
  // `auctionEndUtc` passar, sem precisar adivinhar o desfecho judicial.
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function textoSemHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&aacute;/gi, 'á').replace(/&atilde;/gi, 'ã').replace(/&ccedil;/gi, 'ç')
    .replace(/&oacute;/gi, 'ó').replace(/&ecirc;/gi, 'ê').replace(/&iacute;/gi, 'í')
    .replace(/&uacute;/gi, 'ú').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function isDemoText(value: string): boolean {
  const folded = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(?:testes?|simulador|simulacao|simulados?|simuladas?|treino|treinamento|demonstracao)\b/i.test(folded);
}

function eventDescription(html: string): string {
  const heading = html.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  const activeAssets = html.match(/Ativos disponíveis nesse leilão:\s*<\/p>([\s\S]{0,500}?)(?:<br\s*\/?\s*>|<a\b)/i)?.[1] ?? '';
  return textoSemHtml(`${heading} ${activeAssets}`);
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  url.hash = '';
  return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

/**
 * "24/09/2026 16:05", sempre horário de Brasília (a página mesma diz isso).
 *
 * Leilão sem data marcada ainda devolve "31/10/2035" — sentinela do sistema,
 * não previsão real (medido: mesmo valor em "Encerra a partir de" E
 * "Encerramento previsto" do mesmo leilão, enquanto outro leilão real tinha
 * data plausível dias à frente). Mais de 1 ano no futuro é descartado.
 */
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  if (!Number.isFinite(t)) return null;
  return t < Date.now() + 365 * 24 * 3_600_000 ? new Date(t) : null;
}

interface Card {
  id: string;
  url: string;
  categoria: string;
  titulo: string;
  cidade: string | null;
  uf: string | null;
  status: string;
  foto: string | null;
  valor: number | null;
  rotuloValor: string;
}

function lerCards(html: string, baseUrl: string): Card[] {
  const out: Card[] = [];
  const blocos = html.split('class="lote-lista"').slice(1);
  for (const bloco of blocos) {
    const href = /href='([^']+)'/.exec(bloco)?.[1] ?? /href="([^"]+)"/.exec(bloco)?.[1];
    const id = href?.match(/\/(\d+)$/)?.[1];
    if (!href || !id) continue;
    const foto = bloco.match(/data-src='([^']+)'/)?.[1] ?? null;
    const categoria = bloco.match(/class="col-md-6">\s*([^<]+?)<br/)?.[1]?.trim() ?? '';
    const titulo = bloco.match(/<blockquote>([^<]+)<\/blockquote>/)?.[1]?.trim() ?? '';
    const localTxt = bloco.match(/cidade de\s*<b>([^<]+)<\/b>/)?.[1]?.trim() ?? '';
    const [, cidade, uf] = localTxt.match(/^(.+?)\s*\(([A-Z]{2})\)$/) ?? [null, localTxt || null, null];
    const status = bloco.match(/circulo-item-grande circulo-\w+'>([^<]+)</)?.[1]?.replace(/&nbsp;/g, '').trim() ?? '';
    // As duas variantes (atual/inicial) vêm juntas; só a `display: block` é a
    // que o site mostra de verdade.
    const precoM = bloco.match(/style="display:\s*block"\s*>\s*(Lance \w+):\s*R\$\s*([\d.,]+)/);
    out.push({
      id,
      url: href.startsWith('http') ? href : `${baseUrl}${href}`,
      categoria,
      titulo,
      cidade,
      uf,
      status,
      foto: foto && foto.startsWith('http') ? foto : foto ? `${baseUrl}${foto}` : null,
      valor: dinheiro(precoM?.[2]),
      rotuloValor: precoM?.[1] ?? '',
    });
  }
  return out;
}

export function parseLeiloviaCards(html: string, baseUrl: string): Card[] {
  return lerCards(html, baseUrl);
}

export async function collectLeilovia({ limit, tenant }: CollectOptions, io: { fetchText?: typeof fetchText; fetchTenantText?: typeof fetchTenantText; query?: typeof query } = {}): Promise<CollectResult> {
    const fetch = io.fetchText ?? fetchText;
    const fetchTenant = io.fetchTenantText ?? fetchTenantText;
    const lookup = io.query ?? query;
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    const notes: string[] = [];
    const seenLots = new Set<string>();
    const seenLotUrls = new Set<string>();

    for (const host of await tenants(Number(process.env.LEILOVIA_TENANTS ?? 80), tenant, lookup)) {
      throwIfCancelled();
      if (lots.length >= limit) {
        notes.push(`limite ${limit} atingido antes do tenant ${host}`);
        break;
      }
      const baseUrl = `https://${host}`;
      let r;
      try {
        r = tenant
          ? await fetchTenant(`${baseUrl}/leiloes.aspx`, host, { headers: { 'user-agent': UA }, gapMs: 1100 })
          : await fetch(`${baseUrl}/leiloes.aspx`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        throwIfCancelled();
      } catch (error) {
        if (error instanceof TenantScopeError || error instanceof CollectionCancellationError) throw error;
        throwIfCancelled();
        notes.push(`falha no catálogo ${baseUrl}/leiloes.aspx: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) {
        notes.push(`catálogo ${baseUrl}/leiloes.aspx respondeu HTTP ${r.status}`);
        continue;
      }

      const eventos: string[] = [];
      const vistosEventos = new Set<string>();
      for (const match of r.body.matchAll(/href=["']([^"']+)["']/g)) {
        let url: URL;
        try { url = new URL(match[1], `${baseUrl}/`); } catch { continue; }
        if (!/^https?:$/.test(url.protocol) || !/^\/leilao\/.*\/\d+\/?$/.test(url.pathname)) continue;
        if (url.hostname.toLowerCase().replace(/^www\./, '') !== host.toLowerCase().replace(/^www\./, '')) {
          throw new TenantScopeError(`evento fora do tenant solicitado: ${host}`);
        }
        const key = normalizedUrl(url.href);
        if (vistosEventos.has(key)) continue;
        vistosEventos.add(key);
        eventos.push(url.href);
      }
      if (!eventos.length) notes.push(`nenhum evento observável no catálogo ${baseUrl}/leiloes.aspx`);
      if (/(?:[?&](?:page|pagina|pag)=\d+|class=["'][^"']*(?:pagin|pager))/i.test(r.body)) {
        notes.push(`paginação do catálogo não percorrida em ${baseUrl}/leiloes.aspx`);
      }

      let limitReached = false;
      for (let eventIndex = 0; eventIndex < eventos.length; eventIndex++) {
        throwIfCancelled();
        const eventUrl = eventos[eventIndex];
        if (lots.length >= limit) {
          notes.push(`limite ${limit} atingido; ${eventos.length - eventIndex} eventos observados não percorridos em ${host}`);
          limitReached = true;
          break;
        }
        let er;
        try {
          er = tenant
            ? await fetchTenant(eventUrl, host, { headers: { 'user-agent': UA }, gapMs: 1100 })
            : await fetch(eventUrl, { headers: { 'user-agent': UA }, gapMs: 1100 });
          throwIfCancelled();
        } catch (error) {
          if (error instanceof TenantScopeError || error instanceof CollectionCancellationError) throw error;
          throwIfCancelled();
          notes.push(`falha no evento ${eventUrl}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        httpStatus = er.status;
        if (er.status !== 200) {
          notes.push(`evento ${eventUrl} respondeu HTTP ${er.status}`);
          continue;
        }
        if (/(?:[?&](?:page|pagina|pag)=\d+|class=["'][^"']*(?:pagin|pager))/i.test(er.body)) {
          notes.push(`paginação do evento não percorrida em ${eventUrl}`);
        }

        const encerramento = dataBr(er.body.match(/Encerramento previsto:[\s\S]{0,150}?(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/)?.[1]);
        const demoEvent = isDemoText(`${eventUrl} ${eventDescription(er.body)}`);
        const rawCardCount = er.body.split('class="lote-lista"').length - 1;
        const cards = lerCards(er.body, baseUrl);
        if (cards.some((card) => {
          const url = new URL(card.url);
          return !/^https?:$/.test(url.protocol) || url.hostname.toLowerCase().replace(/^www\./, '') !== host.toLowerCase().replace(/^www\./, '');
        })) {
          throw new TenantScopeError(`lote fora do tenant solicitado: ${host}`);
        }
        fetched += rawCardCount;
        if (cards.length < rawCardCount) {
          const missed = rawCardCount - cards.length;
          skipped += missed;
          notes.push(`${missed} card(s) sem URL/ID parseável em ${eventUrl}`);
        }
        if (!cards.length) {
          notes.push(`nenhum card parseável no evento ${eventUrl}`);
          continue;
        }

        for (const c of cards) {
          throwIfCancelled();
          const lotKey = `${host}:${c.id}`;
          const urlKey = normalizedUrl(c.url);
          if (seenLots.has(lotKey) || seenLotUrls.has(urlKey)) {
            skipped++;
            continue;
          }
          seenLots.add(lotKey);
          seenLotUrls.add(urlKey);
          if (demoEvent || isDemoText(c.titulo) || !c.titulo || looksLikePart(c.titulo)) {
            skipped++;
            continue;
          }
          if (lots.length >= limit) {
            skipped++;
            limitReached = true;
            continue;
          }
          const parsed = parseTitle(c.titulo);
          const local = c.cidade ? { city: campos.apararCidade(c.cidade), uf: c.uf } : campos.localDeTexto(c.titulo);
          const atual = /atual/i.test(c.rotuloValor);

          lots.push({
            sourceId: 'leilovia',
            externalId: `${host}:${c.id}`,
            lotUrl: c.url,
            auctioneerName: leiloeiroDoHost(host),
            titleRaw: c.titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            sourceCategory: c.categoria || null,
            assetType: /im[óo]vel|terrenos?\b/i.test(c.categoria)
              ? 'imovel'
              : /ve[íi]culo|motocicleta|moto\b|caminh[ãa]o|[oô]nibus/i.test(c.categoria)
                ? 'veiculo'
                : 'outro',
            docType: 'judicial',
            closingModel: 'timer_por_lote',
            auctionStartUtc: null,
            auctionEndUtc: encerramento,
            sourceTz: 'America/Sao_Paulo',
            status: statusDe(c.status),
            currentBid: atual ? c.valor : null,
            minBid: atual ? null : c.valor,
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: c.foto ? [c.foto] : [],
            raw: { tenant: host, statusTexto: c.status },
          });
        }
        if (limitReached) {
          const remainingEvents = eventos.length - eventIndex - 1;
          notes.push(`limite ${limit} atingido em ${eventUrl}; ${remainingEvents} eventos observados não percorridos em ${host}`);
          break;
        }
      }
    }
    const note = notes.length ? `cobertura parcial: ${[...new Set(notes)].join('; ')}` : undefined;
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus, ...(note ? { note } : {}) };
}

export const leilovia: Connector = {
  def: {
    id: 'leilovia',
    name: 'Plataforma Leilovia',
    platform: 'Leilovia',
    method: 'html',
    tier: 3,
    siteUrl: 'https://www.leilovia.com.br',
    notes: 'White-label ASP.NET multi-tenant; catálogo em /leiloes.aspx e detalhe em /leilao/<slug>/<id>. Data de encerramento é do leilão, não do lote.',
  },
  collect: collectLeilovia,
};
