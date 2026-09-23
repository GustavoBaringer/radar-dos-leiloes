import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { looksLikePart } from '../core/normalize.js';

/**
 * TABLEAU — leilão de ARTE. O catálogo inteiro (450 lotes) vem numa
 * resposta só em `/catalogo.php`; o filtro "ocultar encerrados" é client-side.
 *
 * `data-enc="1"` é o encerrado e `data-enc="0"` o aberto — é o único sinal
 * confiável de status (o texto do valor diz "ENCERRADO"/"Aguardando oferta",
 * mas some quando há lance). Medido em 22/09: 438 encerrados, 12 abertos.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://tableau.com.br';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

export const tableau: Connector = {
  def: {
    id: 'tableau',
    name: 'Tableau Arte & Leilões',
    platform: 'Tableau',
    method: 'html',
    tier: 4,
    siteUrl: HOST,
    notes: 'Arte e colecionismo. /catalogo.php devolve o catálogo inteiro numa página; status vem do atributo data-enc (1=encerrado, 0=aberto).',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    let r;
    try {
      r = await fetchText(`${HOST}/catalogo.php`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    } catch {
      return { lots, fetched, skipped, httpStatus: 0 };
    }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched, skipped, httpStatus };

    for (const bloco of r.body.split('<article class="lot-card"').slice(1)) {
      if (lots.length >= limit) break;
      const corte = bloco.slice(0, 3000);
      const id = corte.match(/lote\.php\?lote=(\d+)/)?.[1];
      if (!id) continue;
      fetched++;

      const autor = corte.match(/class="lot-card__author"[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      const obra = corte.match(/class="lot-card__titulo"[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      const titulo = [obra, autor].filter(Boolean).join(' — ');
      if (!titulo || looksLikePart(titulo)) {
        skipped++;
        continue;
      }
      const encerrado = /data-enc="1"/.test(corte.slice(0, 300));
      const tecnica = [...corte.matchAll(/class="lot-card__meta"[\s\S]{0,400}?<\/ul>/g)][0]?.[0]
        ?.replace(/<[^>]+>/g, ' | ')
        .replace(/\s*\|\s*/g, ' | ')
        .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim() ?? null;
      const fotoRel = corte.match(/<img src="([^"]+)"/)?.[1] ?? null;
      const foto = fotoRel ? (fotoRel.startsWith('http') ? fotoRel : `${HOST}${fotoRel}`) : null;

      lots.push({
        sourceId: 'tableau',
        externalId: id,
        lotUrl: `${HOST}/lote.php?lote=${id}`,
        titleRaw: titulo,
        assetType: 'outro',
        sourceGroup: 'arte e colecionismo',
        sourceCategory: corte.match(/data-cat="([^"]*)"/)?.[1] || null,
        closingModel: 'pregao_em_horario',
        auctionStartUtc: null,
        auctionEndUtc: null,
        sourceTz: 'America/Sao_Paulo',
        status: encerrado ? 'encerrado' : 'aberto',
        currentBid: dinheiro(corte.match(/class="lot-card__bid-value[^"]*"[^>]*>\s*(R\$[^<]+)</)?.[1]),
        sellerType: 'desconhecido',
        photos: foto ? [foto] : [],
        raw: { autor, obra, tecnica },
      });
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
