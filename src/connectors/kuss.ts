import { fetchText, fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, looksLikePart } from '../core/normalize.js';

const BASE = 'https://www.claudiokussleiloes.com.br';

/**
 * JSON não documentado, sem autenticação. Duas particularidades:
 *  1. A data do leilão NÃO está no JSON dos lotes, só na home. Por isso a
 *     descoberta lê a home e casa cada leilão com a última data que a precede.
 *  2. O campo `usuario` traz o ID do licitante ("Online - ID: 66975").
 *     É dado pessoal e nunca é persistido.
 */
function parseBrDate(date: string, time: string): Date | null {
  const [d, m, y] = date.split('/').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh + 3, mm)); // BRT -> UTC
  return isNaN(dt.getTime()) ? null : dt;
}

function parseMoney(v?: string | null): number | null {
  if (!v) return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function parseYearPair(ano?: string | null): { make: number | null; model: number | null } {
  if (!ano) return { make: null, model: null };
  const m = ano.match(/(\d{2})\s*\/\s*(\d{2})/);
  if (!m) return { make: null, model: null };
  const yr = (v: number) => (v > 50 ? 1900 + v : 2000 + v);
  return { make: yr(Number(m[1])), model: yr(Number(m[2])) };
}

interface KussAuction {
  id: string;
  startUtc: Date | null;
}

async function discoverAuctions(): Promise<KussAuction[]> {
  const { body } = await fetchText(`${BASE}/`, { gapMs: 1000 });
  const out: KussAuction[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/relacao-foto\/(\d+)/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const ctx = body.slice(Math.max(0, m.index! - 1500), m.index!);
    const dates = [...ctx.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*(?:às|as)?\s*(\d{2}:\d{2})?/g)];
    const last = dates[dates.length - 1];
    out.push({ id, startUtc: last ? parseBrDate(last[1], last[2] ?? '10:00') : null });
  }
  return out;
}

export const kuss: Connector = {
  def: {
    id: 'kuss',
    name: 'Cláudio Kuss Leilões',
    platform: 'própria',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.claudiokussleiloes.com.br',
    notes: 'JSON não documentado via POST. Pregão presencial e online: não há encerramento por lote.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const auctions = await discoverAuctions();

    for (const auction of auctions) {
      const count = await fetchJson<any>(`${BASE}/json_edital.php`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `leilaoID=${auction.id}&op=Q&pag=1&loteado=S&pesq=`,
        gapMs: 900,
      });
      status = count.status;
      const pages = Number(count.data?.qtdePag ?? 0);
      if (!pages) continue;

      for (let page = 1; page <= pages && lots.length < limit; page++) {
        const { status: st, data } = await fetchJson<any[]>(`${BASE}/json_edital.php`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `leilaoID=${auction.id}&op=P&pag=${page}&loteado=S&pesq=`,
          gapMs: 900,
        });
        status = st;
        const items = Array.isArray(data) ? data : [];
        if (!items.length) break;
        fetched += items.length;

        for (const it of items) {
          const title = it.bem ?? '';
          if (!title || looksLikePart(title)) {
            skipped++;
            continue;
          }
          const parsed = parseTitle(title);
          const years = parseYearPair(it.ano);
          lots.push({
            sourceId: 'kuss',
            externalId: `${auction.id}-${it.seq}`,
            lotUrl: `${BASE}/lance/${auction.id}/${it.seq}`,
            titleRaw: title,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: years.make ?? parsed.yearMake,
            yearModel: years.model ?? parsed.yearModel,
            km: null,
            fuel: it.comb ?? null,
            docType: null,
            closingModel: 'pregao_em_horario',
            auctionStartUtc: auction.startUtc,
            auctionEndUtc: null,
            sourceTz: 'America/Sao_Paulo',
            status: auction.startUtc && auction.startUtc.getTime() > Date.now() ? 'agendado' : 'aberto',
            currentBid: parseMoney(it.valor),
            minBid: null,
            auctioneerName: 'Cláudio César Kuss',
            auctioneerReg: 'JUCEPAR 507',
            sellerName: null,
            city: 'Curitiba',
            state: 'PR',
            photos: it.foto ? [String(it.foto)] : [],
            raw: { lote: it.lote, seq: it.seq, leilaoId: auction.id, video: it.linkVideo ?? null },
          });
        }
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
