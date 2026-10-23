import * as cheerio from 'cheerio';
import { comNavegador } from './navegador.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { looksLikeCollectible, looksLikePart, classifySeller } from '../core/normalize.js';
import * as campos from '../core/campos.js';
import type { Connector, CollectResult, CollectOptions } from './types.js';
import { throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import { query } from '../core/db.js';

const HOST = 'www.leiloesbrasil.com.br';
const BASE = `https://${HOST}`;
const CATEGORIES = ['veiculos', 'imoveis', 'materiais', 'rurais', 'judiciais', 'diversos'] as const;

interface Candidate {
  id: string;
  route: string;
  category: string;
  dateText: string;
  eventTitle: string;
  lotNumber: string;
}

export function catalogEndpointForCategory(category: string): string {
  return category === 'veiculos' ? '/lotes/listar-dados' : `/lotes/listar-${category}-dados`;
}

export function matchesCatalogResponse(url: string, category: string, method = 'POST'): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const path = category === 'veiculos'
    ? /\/lotes\/listar(?:-veiculos)?-dados(?:\?|$)/
    : new RegExp(`\\/lotes\\/listar-${category}-dados(?:\\?|$)`);
  return path.test(url);
}

export function nextCatalogPage(
  current: number | null | undefined,
  availableRels: string[],
  visitedPages?: Set<number>,
): number | null {
  if (current == null || !Number.isInteger(current) || current < 1) {
    throw new Error(`Esquema inesperado de paginação: página atual inválida (${current})`);
  }
  const visited = visitedPages ?? new Set<number>();
  const candidates: number[] = [];
  for (const rel of availableRels) {
    const trimmed = rel?.trim() ?? '';
    if (/^\d+$/.test(trimmed)) {
      const pageNum = Number(trimmed);
      if (pageNum > current) {
        if (visited.has(pageNum)) {
          throw new Error(`Loop de paginação detectado: página ${pageNum} já visitada`);
        }
        candidates.push(pageNum);
      }
    }
  }
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

export function extractPaginationFromDom(
  html: string,
  visitedPages?: Set<number>,
): { current: number; next: number | null } {
  const $ = cheerio.load(html);
  const selected = $('a.pagina-selecionada').first();
  const relLinks = $('a.js_paginacao[rel]');
  if (!selected.length && !relLinks.length) {
    return { current: 1, next: null };
  }
  const selectedText = selected.text().trim();
  const current = Number(selectedText);
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`Esquema inesperado de paginação: seletor de página atual ausente ou inválido ("${selectedText}")`);
  }
  const rels: string[] = [];
  relLinks.each((_, el) => {
    const rel = $(el).attr('rel');
    if (rel) rels.push(rel);
  });
  const next = nextCatalogPage(current, rels, visitedPages);
  return { current, next };
}

export function parseBrazilianMoney(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.replace(/\s/g, '');
  if (!/\d/.test(text)) return null;
  const n = Number(text.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseAuctionDate(value: string): Date | null {
  const m = value.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{1,2})h(\d{2}))?/i);
  if (!m) return null;
  const [, d, mo, y, hh = '0', mm = '0'] = m;
  const day = Number(d), month = Number(mo), year = Number(y), hour = Number(hh), minute = Number(mm);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  const date = new Date(`${y}-${mo}-${d}T${hh.padStart(2, '0')}:${mm}:00-03:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function asset(title: string, category: string): Pick<CanonicalLot, 'assetType' | 'vehicleType' | 'propertyType'> | null {
  const t = title.toLocaleLowerCase('pt-BR');
  if (/im[oó]vel|apartamento|casa|terreno|fazenda|gleba|ch[aá]cara|galp[aã]o|pr[eé]dio|sala comercial|lote urbano|matr[ií]cula/.test(t) || category === 'imoveis') {
    const propertyType = /apartamento/.test(t) ? 'apartamento' : /casa|resid[eê]ncia|sobrado/.test(t) ? 'casa'
      : /terreno|lote urbano/.test(t) ? 'terreno' : /fazenda|rural|gleba|ch[aá]cara/.test(t) ? 'rural'
        : /galp[aã]o|pr[eé]dio|sala comercial|comercial/.test(t) ? 'comercial' : 'outro';
    return { assetType: 'imovel', propertyType };
  }
  if (/ve[ií]culo|carro|autom[oó]vel|moto|motocicleta|caminh[aã]o|[oô]nibus|picape|pickup|trator|motoniveladora|escavadeira|p[aá] carregadeira|m[aá]quina|equipamento|implemento|reboque/.test(t) || category === 'veiculos') {
    const vehicleType = /moto/.test(t) ? 'moto' : /caminh[aã]o/.test(t) ? 'caminhao' : /[oô]nibus/.test(t) ? 'onibus'
      : /trator|motoniveladora|escavadeira|carregadeira|m[aá]quina|equipamento|implemento/.test(t) ? 'maquina'
        : /picape|pickup|l\d{1,2}\b|saveiro|s10|toro/.test(t) ? 'picape'
          : /suv|utilit[aá]rio/.test(t) ? 'utilitario' : 'carro';
    return { assetType: 'veiculo', vehicleType };
  }
  return null;
}

export function candidateFromRow(row: { id: string; route: string; category: string; dateText: string; eventTitle: string; lotNumber: string }): Candidate | null {
  if (!/^\d+$/.test(row.id) || !/^\d+\/[^/]+\/leilao\/\d{2}-\d{2}-\d{4}\/\d+\/lote\/[^/]+$/.test(row.route)) return null;
  return { ...row };
}

export function parseCatalogResponse(raw: string, category: string): Candidate[] {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new Error(`Invalid Leiloes Brasil catalog JSON in /${category}`); }
  if (!payload || typeof payload !== 'object' || !Number.isSafeInteger((payload as any).total) ||
      typeof (payload as any).dados !== 'string' || typeof (payload as any).totalLotesEncontrados !== 'string') {
    throw new Error(`Unknown Leiloes Brasil catalog schema in /${category}`);
  }
  const $ = cheerio.load(`<table><tbody>${(payload as any).dados}</tbody></table>`);
  const candidates: Candidate[] = [];
  $('tr.js_lote').each((_, row) => {
    const cells = $(row).find('td');
    const eventCell = cells.filter((__, cell) => $(cell).hasClass('js_dataLocalLeilao')).first();
    const candidate = candidateFromRow({
      id: $(row).attr('data-rowid') ?? '', route: $(row).attr('rel') ?? '', category,
      dateText: eventCell.text().replace(/\s+/g, ' ').trim(),
      eventTitle: eventCell.find('.text-truncate[title]').first().attr('title') ?? eventCell.find('[title]').first().attr('title') ?? '',
      lotNumber: cells.eq(1).text().match(/Lote\s*(\d+)/i)?.[1] ?? '',
    });
    if (!candidate) throw new Error(`Unknown Leiloes Brasil lot row schema in /${category}`);
    candidates.push(candidate);
  });
  const total = (payload as any).total as number;
  if (candidates.length > total) throw new Error(`Inconsistent Leiloes Brasil catalog count in /${category}`);
  return candidates;
}

export function parseDetail(html: string, candidate: Candidate, now = Date.now()): CanonicalLot | null {
  const title = (html.match(/<meta[^>]+(?:name|property)=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    ?? html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1])
    ?.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  const stateText = (
    html.match(/id=["']pregao-detalhe["'][^>]*>([\s\S]*?)<\//i)?.[1]
    ?? html.match(/Situa[çc][ãa]o\s+Lote:[\s\S]*?<b[^>]*>([\s\S]*?)<\/b>/i)?.[1]
  )?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title || !stateText) throw new Error(`Unknown Leiloes Brasil lot detail schema (${candidate.id})`);
  const statusText = stateText.toLocaleLowerCase('pt-BR');
  let status: LotStatus;
  if (/vendid|arrematad/.test(statusText)) status = 'vendido';
  else if (/encerrad|cancelad|suspens/.test(statusText)) status = 'encerrado';
  else if (/liberado|aberto|em andamento|placar|ao vivo/.test(statusText)) status = 'aberto';
  else if (/aguardando|em breve/.test(statusText)) status = 'agendado';
  else throw new Error(`Unknown Leiloes Brasil lot status (${candidate.id}): ${stateText}`);
  if (status === 'encerrado' || status === 'vendido') return null;

  const cleanTitle = title.replace(/^L\s*-\s*/i, '').replace(/^Leilões Brasil\s*\|.*?\s-\s*/i, '').replace(/\s*\|\s*Gestora de Leilões.*$/i, '').trim();
  if (!cleanTitle || looksLikePart(cleanTitle) || looksLikeCollectible(cleanTitle)) return null;
  const kinds = asset(cleanTitle, candidate.category);
  if (!kinds) return null;
  const eventDate = parseAuctionDate(candidate.dateText);
  if (!eventDate) throw new Error(`Unknown Leiloes Brasil auction date (${candidate.id}): ${candidate.dateText}`);
  if (status === 'agendado' && eventDate.getTime() <= now) status = 'aberto';
  const minBidText = html.match(/class=["']lance-minimo["'][^>]*>([^<]*)</i)?.[1] ?? null;
  const appraisalText = html.match(/Avalia(?:ç|&ccedil;)[aã]o\s*:?\s*(?:R\$\s*)?([\d.]+,\d{2})/i)?.[1] ?? null;
  const photos = [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*(?:alt|title)=["'][^"']*Foto\s+\d+/gi)]
    .map((m) => m[1]).filter((url) => !/placeholder|sem-foto|noimage/i.test(url));
  const local = campos.localDeTexto(cleanTitle);
  return {
    sourceId: 'leiloesbrasilpublic',
    externalId: `${HOST}:${candidate.id}`,
    lotUrl: `${BASE}/lote/${candidate.id}`,
    titleRaw: cleanTitle,
    docType: candidate.category,
    sourceCategory: candidate.category,
    sourceGroup: candidate.eventTitle,
    ...kinds,
    closingModel: 'pregao_em_horario',
    auctionStartUtc: eventDate,
    auctionEndUtc: null,
    sourceTz: 'America/Sao_Paulo',
    status,
    minBid: parseBrazilianMoney(minBidText),
    appraisal: parseBrazilianMoney(appraisalText),
    sellerType: classifySeller(null) as any,
    city: local?.city ?? null,
    state: local?.uf ?? null,
    photos: [...new Set(photos.map((url) => new URL(url, BASE).href))],
    raw: { eventRoute: candidate.route, lotNumber: candidate.lotNumber, statusText: stateText },
  };
}

export type BrasilLotLookup = (
  lotUrl: string,
  candidateId: string,
) => Promise<
  | { action: 'reuse'; sourceId: string; externalId: string }
  | { action: 'skip'; reason: string }
  | { action: 'insert_new'; externalId: string }
>;

export async function defaultBrasilLookup(
  lotUrl: string,
  candidateId: string,
  dbQuery: typeof query = query,
): Promise<
  | { action: 'reuse'; sourceId: string; externalId: string }
  | { action: 'skip'; reason: string }
  | { action: 'insert_new'; externalId: string }
> {
  const urlRows = await dbQuery<{ id: number; source_id: string; external_id: string; lot_url: string }>(
    `SELECT id, source_id, external_id, lot_url
       FROM lots
      WHERE lower(regexp_replace(lot_url, '^https?://(www\\.)?', '')) =
            lower(regexp_replace($1, '^https?://(www\\.)?', ''))
      ORDER BY id ASC`,
    [lotUrl],
  );

  if (urlRows.length > 1) {
    return {
      action: 'skip',
      reason: `múltiplos registros existentes para URL ${lotUrl}; pulado até limpeza manual`,
    };
  }

  if (urlRows.length === 1) {
    return {
      action: 'reuse',
      sourceId: urlRows[0].source_id,
      externalId: urlRows[0].external_id,
    };
  }

  const proposedApex = `leiloesbrasil.com.br:${candidateId}`;
  const proposedWww = `www.leiloesbrasil.com.br:${candidateId}`;
  const idRows = await dbQuery<{ id: number; source_id: string; external_id: string; lot_url: string }>(
    `SELECT id, source_id, external_id, lot_url
       FROM lots
      WHERE external_id IN ($1, $2)
      LIMIT 1`,
    [proposedApex, proposedWww],
  );

  if (idRows.length > 0) {
    return {
      action: 'skip',
      reason: `colisão de external_id (${idRows[0].external_id}) com outra URL existente (${idRows[0].lot_url})`,
    };
  }

  return {
    action: 'insert_new',
    externalId: proposedWww,
  };
}

export const leiloesbrasilPublic: Connector = {
  def: {
    id: 'leiloesbrasilpublic', name: 'Leilões Brasil (catálogo público)', platform: 'Leilões Brasil',
    method: 'html', tier: 3, siteUrl: BASE,
    notes: 'Catálogo público acessado pelo Chromium comum; seis categorias públicas, paginação oficial e detalhe dos lotes.',
  },
  async collect(
    { limit, tenant, observer }: CollectOptions,
    io: { query?: typeof query; lookup?: BrasilLotLookup } = {},
  ): Promise<CollectResult> {
    const hostname = tenant?.toLowerCase().replace(/\.$/, '');
    if (hostname && hostname !== HOST && hostname !== 'leiloesbrasil.com.br') throw new Error(`Tenant inválido para leiloesbrasilpublic: ${tenant}`);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit deve ser um inteiro positivo');
    const attempt = await observer?.start(HOST);
    const lookup: BrasilLotLookup = io.lookup ?? ((url, id) => defaultBrasilLookup(url, id, io.query ?? query));
    let fetched = 0, skipped = 0, httpStatus: number | undefined;
    let truncated = false;
    let returned = 0;
    const partialReasons = new Set<string>();
    try {
      const lots = await comNavegador(`${BASE}/veiculos`, async (page) => {
        const output: CanonicalLot[] = [];
        const seen = new Set<string>();
        for (const category of CATEGORIES) {
          throwIfCancelled();
          if (output.length >= limit) { truncated = true; break; }
          const visitedPages = new Set<number>();
          const firstPageResponse = page.waitForResponse((r) => matchesCatalogResponse(r.url(), category, r.request().method()), { timeout: 30000 }).catch(() => null);
          const response = await page.goto(`${BASE}/${category}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          httpStatus = response?.status() ?? undefined;
          if (httpStatus) attempt?.response(httpStatus);
          if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus} em /${category}`);
          let catalogResponse = await firstPageResponse;
          if (!catalogResponse) throw new Error(`No catalog response for /${category}`);
          httpStatus = catalogResponse.status();
          attempt?.response(httpStatus);
          if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus} no catálogo /${category}`);
          await page.waitForFunction(() => !!document.querySelector('tr.js_lote, a.js_paginacao[rel]') || /lotes encontrados|nenhum lote/i.test(document.body.innerText), null, { timeout: 20000 });
          while (true) {
            throwIfCancelled();
            const rows = parseCatalogResponse(await catalogResponse.text(), category);
            for (const data of rows) {
              throwIfCancelled();
              fetched++;
              const candidate = candidateFromRow(data);
              if (!candidate || seen.has(candidate.id)) { skipped++; continue; }
              seen.add(candidate.id);
              if (output.length >= limit) { truncated = true; break; }
              const detail = await page.evaluate(async (id) => {
                const res = await fetch(`/lote/${id}`);
                return { status: res.status, html: await res.text() };
              }, candidate.id);
              attempt?.response(detail.status);
              if (detail.status !== 200) { skipped++; continue; }
              const html = detail.html;
              const parsed = parseDetail(html, candidate);
              if (parsed) {
                const targetLotUrl = parsed.lotUrl ?? `${BASE}/lote/${candidate.id}`;
                const lookupRes = await lookup(targetLotUrl, candidate.id);
                if (lookupRes.action === 'skip') {
                  partialReasons.add(lookupRes.reason);
                  skipped++;
                  continue;
                }
                if (lookupRes.action === 'reuse') {
                  parsed.sourceId = lookupRes.sourceId;
                  parsed.externalId = lookupRes.externalId;
                } else {
                  parsed.externalId = lookupRes.externalId;
                }
                output.push(parsed);
              } else {
                skipped++;
              }
            }
            if (truncated || output.length >= limit) {
              truncated ||= (await page.locator('a.js_paginacao[rel]').count()) > 0 || CATEGORIES.indexOf(category as typeof CATEGORIES[number]) < CATEGORIES.length - 1;
              break;
            }

            const paginationInfo = await page.evaluate((visitedArr: number[]) => {
              const selected = document.querySelector('a.pagina-selecionada');
              const relLinks = Array.from(document.querySelectorAll('a.js_paginacao[rel]'));
              if (!selected && !relLinks.length) {
                return { current: 1, next: null };
              }
              const selectedText = selected?.textContent?.trim() ?? '';
              const current = Number(selectedText);
              if (!Number.isInteger(current) || current < 1) {
                return { error: `invalid_current_page: "${selectedText}"` };
              }
              const visited = new Set(visitedArr);
              visited.add(current);
              const candidates: number[] = [];
              for (const a of relLinks) {
                const rel = a.getAttribute('rel')?.trim() ?? '';
                if (/^\d+$/.test(rel)) {
                  const pNum = Number(rel);
                  if (pNum > current) {
                    if (visited.has(pNum)) return { error: `loop_detected: página ${pNum} já visitada` };
                    candidates.push(pNum);
                  }
                }
              }
              if (!candidates.length) return { current, next: null };
              return { current, next: Math.min(...candidates) };
            }, [...visitedPages]);

            if ('error' in paginationInfo) {
              throw new Error(`Esquema inesperado de paginação em /${category}: ${paginationInfo.error}`);
            }

            visitedPages.add(paginationInfo.current);
            if (paginationInfo.next === null) {
              break;
            }

            const next = paginationInfo.next;
            visitedPages.add(next);
            const nextSelector = `a.js_paginacao[rel="${next}"]`;
            const nextLocator = page.locator(nextSelector).first();
            if (!(await nextLocator.count())) break;

            const nextPageResponse = page.waitForResponse((r) => matchesCatalogResponse(r.url(), category, r.request().method()), { timeout: 30000 }).catch(() => null);
            await nextLocator.click();
            await page.waitForFunction((expected) => document.querySelector('a.pagina-selecionada')?.textContent?.trim() === String(expected), next, { timeout: 20000 });
            catalogResponse = await nextPageResponse;
            if (!catalogResponse) throw new Error(`No catalog response for page ${next} in /${category}`);
            httpStatus = catalogResponse.status();
            attempt?.response(httpStatus);
            if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus} na página ${next} de /${category}`);
          }
        }
        return output;
      });
      returned = lots.length;
      return {
        lots,
        fetched,
        skipped,
        httpStatus,
        note: partialReasons.size
          ? [...partialReasons].join('; ')
          : truncated
            ? 'limite atingido; catálogo parcial'
            : undefined,
      };
    } catch (error) {
      attempt?.failure('parser');
      throw error;
    } finally {
      await attempt?.finish({ fetched, skipped, returned, truncated });
    }
  },
};
