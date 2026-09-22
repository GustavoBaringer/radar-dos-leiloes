import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * PARQUE DOS LEILÕES — home lista EVENTOS (`div.auction-card`), e cada evento
 * tem a lista de lotes em `/leilao/{id}/detalhes?page=N` (`div.auction-lot-card`).
 * Medido em 22/09: 4 eventos "Lances online agora" somando ~363 lotes.
 *
 * O badge de status do lote já traz a data de encerramento embutida no texto
 * ("Lances On-Line até 23/09/26 13:00:00") — é a única fonte de data na
 * listagem, e evita uma requisição por lote só pra saber quando fecha.
 *
 * Preço NÃO existe na listagem (só no detalhe do lote, em `data-name=
 * "min_bid_value"`). Com centenas de lotes, buscar detalhe de cada um sairia
 * caro; fica sem preço, que é honesto, em vez de inventar.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://www.parquedosleiloes.com.br';
const PAGINAS_POR_EVENTO = 6;

function dataBr(v?: string | null): Date | null {
  // "23/09/26 13:00:00" — ano com 2 dígitos.
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, aRaw, h, min] = m;
  const a = aRaw.length === 2 ? `20${aRaw}` : aRaw;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function statusDe(texto: string, statusId: string): LotStatus {
  const t = texto.toLowerCase();
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/encerrad|cancelad|retirad|suspens/.test(t)) return 'encerrado';
  if (/lances on-?line|aberto|em leil/.test(t)) return 'aberto';
  if (/em breve|agendad|aguard/.test(t)) return 'agendado';
  return statusId === '2' ? 'aberto' : 'sem_data';
}

export const parquedosleiloes: Connector = {
  def: {
    id: 'parquedosleiloes',
    name: 'Parque dos Leilões',
    platform: 'Parque dos Leilões',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home lista eventos; lotes em /leilao/{id}/detalhes?page=N. Data vem dentro do texto do badge de status; preço só no detalhe do lote (não coletado).',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    let home;
    try {
      home = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    } catch {
      return { lots, fetched, skipped, httpStatus: 0 };
    }
    httpStatus = home.status;
    if (home.status !== 200) return { lots, fetched, skipped, httpStatus };

    const eventos = [...new Set([...home.body.matchAll(/\/leilao\/(\d+)\/detalhes/g)].map((m) => m[1]))];

    for (const evento of eventos) {
      if (lots.length >= limit) break;
      for (let pagina = 1; pagina <= PAGINAS_POR_EVENTO && lots.length < limit; pagina++) {
        let r;
        try {
          r = await fetchText(`${HOST}/leilao/${evento}/detalhes?page=${pagina}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        } catch {
          break;
        }
        httpStatus = r.status;
        if (r.status !== 200) break;

        const cards = r.body.split('class="card auction-lot-card"').slice(1);
        if (!cards.length) break;
        fetched += cards.length;

        for (const bloco of cards) {
          if (lots.length >= limit) break;
          const corte = bloco.slice(0, 4000);
          const id = corte.match(/\/leilao\/\d+\/lote\/(\d+)/)?.[1];
          if (!id || vistos.has(id)) continue;
          vistos.add(id);
          const titulo = corte.match(/class="name"[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
          if (!titulo || looksLikePart(titulo)) {
            skipped++;
            continue;
          }
          const statusM = corte.match(/class="badge lot-status-color[^"]*"\s*data-lot-status-id="(\d+)"[^>]*>([^<]*)</);
          const statusTxt = statusM?.[2]?.trim() ?? '';
          const parsed = parseTitle(titulo);
          const local = campos.localDeTexto(titulo);

          lots.push({
            sourceId: 'parquedosleiloes',
            externalId: id,
            lotUrl: `${HOST}/leilao/${evento}/lote/${id}`,
            titleRaw: titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            assetType: /im[óo]vel|apartamento|casa|terreno|sala|galp/i.test(titulo) ? 'imovel' : parsed.brand ? 'veiculo' : 'outro',
            closingModel: 'timer_por_lote',
            auctionStartUtc: null,
            auctionEndUtc: dataBr(statusTxt),
            sourceTz: 'America/Sao_Paulo',
            status: statusDe(statusTxt, statusM?.[1] ?? ''),
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: [],
            raw: { evento, statusTexto: statusTxt },
          });
        }
        if (cards.length < 12) break;
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
