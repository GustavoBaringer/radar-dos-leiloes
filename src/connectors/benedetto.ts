import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * BENEDETTO (Laravel/PowerWeb) — o caso mais limpo dos leiloeiros de domínio
 * próprio: `/leiloes` devolve os 91 lotes numa página só, sem paginação.
 *
 * O site tem TRÊS vocabulários de status convivendo (badge da listagem:
 * ABERTO/EM BREVE/FINALIZADO; badge do detalhe: EM ANDAMENTO; JSON interno:
 * DISPONÍVEL/EM_ANDAMENTO). Uso o da listagem — é o único que aparece sem
 * uma requisição por lote, e é o que o próprio site mostra ao comprador.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://benedettoleiloes.com.br';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function statusDe(v: string): LotStatus {
  const t = v.toUpperCase();
  if (/FINALIZAD|ENCERRAD|CANCELAD/.test(t)) return 'encerrado';
  if (/ABERTO|EM ANDAMENTO/.test(t)) return 'aberto';
  if (/EM BREVE|AGENDAD/.test(t)) return 'agendado';
  return 'sem_data';
}

/** "10/07 09:00 a  8/10 de 2026 15:00" — o ano só aparece no fim. */
function fimDaJanela(v: string): Date | null {
  const m = v.match(/a\s+(\d{1,2})\/(\d{1,2})\s+de\s+(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

export const benedetto: Connector = {
  def: {
    id: 'benedetto',
    name: 'Benedetto Leilões',
    platform: 'PowerWeb (Laravel)',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: '/leiloes traz os 91 lotes numa página só. Título é o número do processo; descrição tem o bem e a cidade/UF.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    let r;
    try {
      r = await fetchText(`${HOST}/leiloes`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    } catch {
      return { lots, fetched, skipped, httpStatus: 0 };
    }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched, skipped, httpStatus };

    for (const bloco of r.body.split('class="leilao-item media"').slice(1)) {
      if (lots.length >= limit) break;
      const corte = bloco.slice(0, 4000);
      const id = corte.match(/\/lance\/(\d+)/)?.[1];
      if (!id) continue;
      fetched++;

      const processo = corte.match(/Processo:\s*<b>([^<]+)<\/b>/)?.[1]?.trim() ?? null;
      const janela = corte.match(/class="text-default small"[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      const descricao = corte
        .match(/<span>\s*<p[^>]*>([\s\S]{0,600}?)<\/p>/)?.[1]
        ?.replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() ?? '';
      const titulo = descricao || (processo ? `Processo ${processo}` : '');
      if (!titulo || looksLikePart(titulo)) {
        skipped++;
        continue;
      }
      const parsed = parseTitle(titulo);
      const local = campos.localDeTexto(descricao);
      // A própria fonte usa esse arquivo como placeholder de "sem foto" —
      // gravar como se fosse retrato real quebraria a honestidade do card.
      const fotoM = corte.match(/<img src="([^"]+)"/)?.[1];
      const foto = fotoM && !/sem_imagem/i.test(fotoM) ? fotoM : null;

      lots.push({
        sourceId: 'benedetto',
        externalId: id,
        lotUrl: `${HOST}/lance/${id}`,
        titleRaw: titulo.slice(0, 200),
        brand: parsed.brand,
        model: parsed.model,
        yearMake: parsed.yearMake,
        yearModel: parsed.yearModel,
        assetType: /im[óo]vel|casa|apartamento|terreno|lote de terra|sala|galp/i.test(descricao)
          ? 'imovel'
          : parsed.brand
            ? 'veiculo'
            : 'outro',
        docType: processo ? 'judicial' : null,
        closingModel: 'timer_por_lote',
        auctionStartUtc: null,
        auctionEndUtc: fimDaJanela(janela),
        sourceTz: 'America/Sao_Paulo',
        status: statusDe(corte.match(/class="pull-right label label-\w+"[^>]*>([^<]+)</)?.[1]?.trim() ?? ''),
        minBid: dinheiro(corte.match(/Lance Inicial:\s*<strong>([^<]+)</)?.[1]),
        sellerType: classifySeller(null) as any,
        city: local?.city ?? null,
        state: local?.uf ?? null,
        photos: foto ? [foto] : [],
        raw: { processo, janela },
      });
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
