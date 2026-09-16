import { fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const URL_SEARCH = 'https://www.copart.com.br/public/lots/search';

/**
 * Duas descobertas que mudam a integração (medidas em 14/09/2026):
 *  1. O endpoint lê form-urlencoded. Enviar JSON faz a API ignorar TUDO
 *     (devolve os 13 mil lotes e size=10 mesmo pedindo outra coisa).
 *  2. `filter[MISC]=dataleilao:*` separa os ~1.400 lotes com leilão marcado
 *     dos ~11.800 "aguardando classificação", que não têm data nem lance.
 * A data vem em UTC e sem hora separada; o Superbid vem em BRT. Daí source_tz.
 */
function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function parseUtc(s?: string | null): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * `tims` vem com `?imageType=thumbnail`, que a origem serve em 96x72 — ilegível
 * no cartão. Qualquer outro valor (ou nenhum) devolve 1600x1200, mesmo arquivo
 * e mesmo custo para a origem. Medido em 14/09/2026.
 */
function fullSizePhoto(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.delete('imageType');
    return u.toString();
  } catch {
    return url;
  }
}

function docTypeOf(c: any): string | null {
  const parts = [c.td || c.stt, c.damageClassification].filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

function mapLot(c: any): CanonicalLot | null {
  const title = c.ld ?? [c.lcy, c.mkn, c.lm].filter(Boolean).join(' ');
  if (!title || looksLikePart(title)) return null;
  const parsed = parseTitle(title, c.mkn !== 'UNKNOWN' ? c.mkn : null, c.lm);
  const start = parseUtc(c.ad);
  const yard = c.yn ?? null;
  const uf = typeof yard === 'string' && / - ([A-Z]{2})$/.test(yard) ? yard.match(/ - ([A-Z]{2})$/)![1] : null;
  const city = typeof yard === 'string' ? yard.replace(/ - [A-Z]{2}$/, '').trim() : null;
  const km = Number(c.orr) > 0 ? Number(c.orr) : null;

  return {
    sourceId: 'copart',
    externalId: String(c.ln),
    lotUrl: `https://www.copart.com.br/lot/${c.ln}`,
    titleRaw: title,
    brand: parsed.brand ?? (c.mkn !== 'UNKNOWN' ? c.mkn : null),
    // Modelo cru da fonte NÃO vai para o campo estrutural: gravar 'GLAZ00FF'
    // fazia a busca por 'gla' (que vira igualdade model='GLA') devolver zero.
    // Sem modelo, a consulta cai no trigram do texto e o lote volta a ser achável.
    model: parsed.model,
    version: c.eng ?? null,
    yearMake: Number(c.manufactureYear) || parsed.yearMake,
    yearModel: Number(c.lcy) || parsed.yearModel,
    km,
    fuel: null,
    docType: docTypeOf(c),
    sourceCategory: c.vehicleType ?? null,
    // Leilão virtual em horário marcado: não existe encerramento por lote.
    closingModel: 'pregao_em_horario',
    auctionStartUtc: start,
    auctionEndUtc: null,
    sourceTz: 'UTC',
    status: start ? (start.getTime() > Date.now() ? 'agendado' : 'aberto') : 'sem_data',
    currentBid: Number(c.hb) > 0 ? Number(c.hb) : null,
    minBid: Number(c.ymin) > 0 ? Number(c.ymin) : null,
    appraisal: Number(c.la) > 0 ? Number(c.la) : null,
    auctioneerName: null,
    sellerName: c.sellerName ?? null,
    sellerType: classifySeller(c.sellerName) as any,
    yard,
    city,
    state: uf,
    photos: [fullSizePhoto(c.tims)].filter((p): p is string => Boolean(p)),
    raw: {
      lossType: c.lossType,
      damage: c.dd,
      drivability: c.drivabilityRating,
      photoCount: c.phynumb,
      saleYard: c.syn,
      vehicleType: c.vehicleType,
      modeloFonte: c.lm ?? null,
    },
  };
}

export const copart: Connector = {
  def: {
    id: 'copart',
    name: 'Copart Brasil',
    platform: 'própria',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.copart.com.br',
    notes: 'POST form-urlencoded passa pelo Imperva; HTML e imagens são bloqueados. 89% do estoque sem data.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const pageSize = 100;

    for (let page = 0; lots.length < limit; page++) {
      const body = form({
        query: '*',
        'filter[MISC]': 'dataleilao:*',
        size: String(pageSize),
        page: String(page),
      });
      const { status: st, data } = await fetchJson<any>(URL_SEARCH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        gapMs: 1200,
      });
      status = st;
      const content: any[] = data?.data?.results?.content ?? [];
      if (!content.length) break;
      fetched += content.length;
      for (const c of content) {
        const mapped = mapLot(c);
        if (mapped) lots.push(mapped);
        else skipped++;
      }
      if (content.length < pageSize) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
