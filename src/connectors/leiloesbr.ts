import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * LEILOESBR — plataforma white-label ASP antiga (IIS), voltada a arte e
 * colecionismo (porcelana, filatelia, numismática), não veículo/imóvel.
 * 58 domínios descobertos em 22/09; a sonda achou lote em só 7 porque o
 * vocabulário desta fonte não bate no regex genérico de "lote"/"lance".
 *
 * Sem paginação de EVENTOS: `catalogo.asp` lista só os leilões ativos do
 * tenant (poucos, ~7). Cada evento pagina ITENS via `catalogo.asp?Num=X&pag=N`
 * — um evento chegou a 16 páginas — e todo item aparece DUAS VEZES no HTML
 * (bloco mobile + desktop, mesmo ID); dedupe por `ID`.
 *
 * Sem status por item na listagem — só "Valor inicial" (sem lance) ou "Valor
 * atual" (com lance). O que fecha o lote é o RELÓGIO: a data do evento
 * (`og:description`, "Leilão: DD/MM/AAAA", sem hora) vira `auctionStartUtc`
 * às 23:59:59 BRT, e a regra de vencimento (`VENCIDO` em encerramento.ts) que
 * já existe pro pregão dos outros conectores fecha sozinha — não precisamos
 * adivinhar status.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** Eventos por tenant nesta passada — um catálogo grande (576+ itens) não pode
 * consumir a cota inteira de um `limit` pequeno sozinho. */
const EVENTOS_POR_TENANT = 3;
const PAGINAS_POR_EVENTO = 6;

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='leiloesbr' AND http_status=200
      ORDER BY auctioneers DESC LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
}

function dinheiro(v?: string | null): number | null {
  if (!v || /sob\s+consulta/i.test(v)) return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

/** "Leilão: 28/09/2026" no <meta og:description> — sem hora, fecha às 23:59:59 BRT. */
function dataDoEvento(html: string): Date | null {
  const m = html.match(/Leil[ãa]o:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!m) return null;
  const [, d, mes, a] = m;
  const t = Date.parse(`${a}-${mes}-${d}T23:59:59-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

interface Item {
  id: string;
  titulo: string;
  foto: string | null;
  valor: number | null;
  temLance: boolean;
}

function lerItens($: cheerio.CheerioAPI): Item[] {
  const vistos = new Set<string>();
  const out: Item[] = [];
  $('h3 a[href*="peca.asp?ID="]').each((_, el) => {
    const $a = $(el);
    const id = $a.attr('href')?.match(/ID=(\d+)/)?.[1];
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    const $li = $a.closest('li');
    const precoTxt = $li.find('.price-bid').first().text().trim();
    const lancesTxt = $li.find('.product-price-bid').first().text();
    out.push({
      id,
      titulo: $a.text().replace(/\s+/g, ' ').trim(),
      foto: $li.find('img').first().attr('src') ?? null,
      valor: dinheiro(precoTxt),
      temLance: !/^\s*0\s*Lance/i.test(lancesTxt.replace(/\s+/g, ' ')),
    });
  });
  return out;
}

export const leiloesbr: Connector = {
  def: {
    id: 'leiloesbr',
    name: 'Plataforma LeiloesBR',
    platform: 'LeiloesBR',
    method: 'html',
    tier: 3,
    siteUrl: 'https://www.leiloesbr.com.br',
    notes: 'White-label ASP/IIS, arte e colecionismo. Sem status por item — fecha pelo relógio (data do evento, sem hora, 23:59:59 BRT).',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.LEILOESBR_TENANTS ?? 58));
    const cota = Math.max(30, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      const antesHost = lots.length;
      let r;
      try {
        r = await fetchText(`https://${host}/catalogo.asp`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const nums = [...new Set([...r.body.matchAll(/catalogo\.asp\?Num=(\d+)/g)].map((m) => m[1]))].slice(0, EVENTOS_POR_TENANT);

      for (const num of nums) {
        const antesEvento = lots.length;
        let dataEvento: Date | null = null;

        for (let pag = 1; pag <= PAGINAS_POR_EVENTO && lots.length - antesEvento < cota && lots.length < limit; pag++) {
          const url = `https://${host}/catalogo.asp?Num=${num}${pag > 1 ? `&pag=${pag}` : ''}`;
          let er;
          try {
            er = await fetchText(url, { headers: { 'user-agent': UA }, gapMs: 1100 });
          } catch {
            break;
          }
          httpStatus = er.status;
          if (er.status !== 200) break;
          dataEvento ??= dataDoEvento(er.body);

          const $ = cheerio.load(er.body);
          const itens = lerItens($);
          if (!itens.length) break;
          fetched += itens.length;

          for (const it of itens) {
            if (!it.titulo) {
              skipped++;
              continue;
            }
            const local = campos.localDeTexto(it.titulo);
            const futuro = dataEvento != null && +dataEvento > Date.now();
            lots.push({
              sourceId: 'leiloesbr',
              externalId: `${host}:${it.id}`,
              lotUrl: `https://${host}/peca.asp?ID=${it.id}`,
              titleRaw: it.titulo,
              docType: 'colecionismo',
              sourceGroup: 'arte e colecionismo',
              assetType: 'outro',
              closingModel: 'pregao_em_horario',
              auctionStartUtc: dataEvento,
              auctionEndUtc: null,
              sourceTz: 'America/Sao_Paulo',
              status: futuro ? 'agendado' : 'aberto',
              currentBid: it.temLance ? it.valor : null,
              minBid: it.temLance ? null : it.valor,
              sellerType: classifySeller(null) as any,
              city: local?.city ?? null,
              state: local?.uf ?? null,
              photos: it.foto ? [it.foto.startsWith('http') ? it.foto : `https://${host}/${it.foto.replace(/^\//, '')}`] : [],
              raw: { tenant: host, evento: num, dataEvento: dataEvento?.toISOString() ?? null },
            });
          }
        }
        if (lots.length - antesHost >= cota) break;
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
