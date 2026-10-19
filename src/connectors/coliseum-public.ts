import * as cheerio from 'cheerio';
import { fetchText, fetchJson } from './http.js';
import { throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import { parseTitle, classifyAsset, looksLikePart, looksLikeCollectible } from '../core/normalize.js';
import type { Connector } from './types.js';
import type { CanonicalLot } from '../core/types.js';

const DOMAIN = 'coliseumleiloes.com.br';
const BASE = `https://www.${DOMAIN}`;
export function coliseumEvents(html: string): string[] {
  const $ = cheerio.load(html), ids = new Set<string>();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, `${BASE}/site/index.php`);
      if (u.hostname.replace(/^www\./, '') === DOMAIN && u.pathname === '/site/listar-lotes.php') {
        const id = u.searchParams.get('codLeilao'); if (id && /^\d+$/.test(id)) ids.add(id);
      }
    } catch { /* malformed unrelated link */ }
  });
  return [...ids];
}

export function mapColiseumLot(item: any, event: string): CanonicalLot | null {
  const id = String(item?.id ?? ''), title = String(item?.marcaModelo ?? '').trim();
  if (!/^\d+$/.test(id) || !title || looksLikePart(title) || looksLikeCollectible(title)) return null;
  const parsed = parseTitle(title), type = classifyAsset(title, parsed.brand ? 'veiculo' : null);
  if (type.assetType === 'outro') return null;
  const years = String(item.ano ?? '').match(/^(\d{4})\/(\d{4})$/);
  const rawPhoto = String(item.foto ?? '');
  const amount = String(item.lance ?? '').replace(/[^\d,.-]/g, '');
  // The API also returns ordinary decimal numbers; periods are not always thousands separators.
  const money = typeof item.lance === 'number' ? item.lance
    : Number(amount.includes(',') ? amount.replace(/\./g, '').replace(',', '.') : amount);
  return { sourceId: 'coliseumpublic', externalId: id,
    lotUrl: `${BASE}/site/listar-lotes.php?codLeilao=${event}&codLote=${id}`,
    titleRaw: title, assetType: type.assetType, vehicleType: type.vehicleType,
    brand: parsed.brand, model: parsed.model, version: parsed.version,
    yearMake: years ? Number(years[1]) : null, yearModel: years ? Number(years[2]) : null,
    color: item.cor || null, currentBid: Number.isFinite(money) && money > 0 ? money : null,
    closingModel: 'sequencial', status: 'aberto', sourceTz: 'America/Sao_Paulo',
    photos: rawPhoto ? [new URL(rawPhoto, `${BASE}/site/`).href] : [],
    raw: { tenant: DOMAIN, event, condition: item.observacoes ?? null },
  };
}

export const coliseumPublic: Connector = {
  def: { id: 'coliseumpublic', name: 'Coliseum Leilões', method: 'api', tier: 3, siteUrl: BASE,
    notes: 'Public event links codLeilao and paginated buscarLotes.php; no guessed event identifiers.' },
  async collect({ limit, tenant, observer }) {
    if (tenant && tenant !== DOMAIN) throw new Error('Unreviewed Coliseum tenant');
    const attempt = await observer?.start(DOMAIN);
    const lots: CanonicalLot[] = []; const seen = new Set<string>(); let fetched = 0, skipped = 0, status = 0, partial = false;
    try {
      const home = await fetchText(`${BASE}/site/index.php`, { gapMs: 1100 });
      status = home.status; attempt?.response(status);
      if (status !== 200) throw Object.assign(new Error(`Coliseum home HTTP ${status}`), { httpStatus: status });
      const events = coliseumEvents(home.body);
      if (!events.length) return { lots, fetched, skipped, httpStatus: status, note: 'No published event/catalog links; monitor only.' };
      for (const event of events) {
        for (let page = 1; page <= 100; page++) {
          throwIfCancelled();
          const response = await fetchJson<any>(`${BASE}/site/buscarLotes.php`, {
            method: 'POST', gapMs: 1100, timeoutMs: 30000,
            headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${BASE}/site/listar-lotes.php?codLeilao=${event}` },
            body: new URLSearchParams({ idLeilao: event, page: String(page), idTipo: '', idSucata: '' }).toString(),
          });
          status = response.status; attempt?.response(status);
          const rows = response.data?.[0]?.lote;
          if (status !== 200 || !Array.isArray(rows)) throw Object.assign(new Error(`Coliseum catalog HTTP ${status} / invalid payload`), { httpStatus: status });
          fetched += rows.length;
          for (const item of rows) {
            if (lots.length >= limit) { partial = true; break; }
            const mapped = mapColiseumLot(item, event);
            if (!mapped) { skipped++; continue; }
            if (!seen.has(mapped.externalId)) { seen.add(mapped.externalId); lots.push(mapped); }
          }
          if (partial || page >= Number(response.data?.[1]?.lotes?.paginas ?? 1) || !rows.length) break;
          if (page === 100) partial = true;
        }
        if (partial) break;
      }
      return { lots, fetched, skipped, httpStatus: status, note: partial ? 'Coliseum catalog limited; additional pages remain.' : undefined };
    } catch (error) { attempt?.failure((error as { kind?: string }).kind === 'deadline' ? 'budget' : 'parser'); throw error; }
    finally { await attempt?.finish({ fetched, skipped, returned: lots.length, truncated: partial }); }
  },
};
