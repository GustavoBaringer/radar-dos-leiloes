import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, AssetType } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * LUCIAN LEILÕES — `/leiloes` devolve os ~106 lotes ativos numa página só,
 * sem paginação (confirmado: mesma contagem na home e em /leiloes).
 *
 * A categoria vem no PRÓPRIO path do link (`categoria/{id}/{slug}/leilao/...`)
 * — id 5=bens diversos, 6=imóveis, 7=veículos — mais confiável que adivinhar
 * pelo título.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://lucianleiloes.com.br';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

const CATEGORIA: Record<string, AssetType> = { '5': 'outro', '6': 'imovel', '7': 'veiculo' };

export const lucianleiloes: Connector = {
  def: {
    id: 'lucianleiloes',
    name: 'Lucian Leilões',
    platform: 'Lucian Leilões',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: '/leiloes traz todos os lotes numa página só, sem paginação. Categoria vem no path do link (5=bens diversos, 6=imóveis, 7=veículos).',
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

    for (const bloco of r.body.split('class="card h-100"').slice(1)) {
      if (lots.length >= limit) break;
      const corte = bloco.slice(0, 3000);
      const href = corte.match(/href="(categoria\/(\d+)\/[^"]+)"/);
      if (!href) continue;
      const id = href[1].match(/leilao\/(\d+)/)?.[1];
      if (!id) continue;
      fetched++;

      const titulo = corte.match(/class="card-title"[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      if (!titulo || looksLikePart(titulo)) {
        skipped++;
        continue;
      }
      const parsed = parseTitle(titulo);
      const local = campos.localDeTexto(titulo);
      const datas = [...corte.matchAll(/\d[°º]?\s*Leil[ãa]o:\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/g)].map((m) => m[1]);
      const fotoRel = corte.match(/<img src="([^"]+)"/)?.[1] ?? null;
      const foto = fotoRel ? (fotoRel.startsWith('http') ? fotoRel : `${HOST}${fotoRel}`) : null;

      lots.push({
        sourceId: 'lucianleiloes',
        externalId: id,
        lotUrl: `${HOST}/${href[1]}`,
        titleRaw: titulo,
        brand: parsed.brand,
        model: parsed.model,
        yearMake: parsed.yearMake,
        yearModel: parsed.yearModel,
        assetType: CATEGORIA[href[2]] ?? (parsed.brand ? 'veiculo' : 'outro'),
        docType: 'judicial',
        closingModel: 'timer_por_lote',
        auctionStartUtc: dataBr(datas[0]),
        auctionEndUtc: dataBr(datas[datas.length - 1]) ?? dataBr(datas[0]),
        sourceTz: 'America/Sao_Paulo',
        // A classe "nav-item desativado" marca a 1ª praça já vencida, mas o
        // botão do card ("Aberto para lances") é o único sinal direto —
        // única variante vista na amostra atual.
        status: /aberto para lances/i.test(corte) ? 'aberto' : 'sem_data',
        minBid: dinheiro(corte.match(/Lance inicial:\s*R\$\s*([\d.,]+)/)?.[1]),
        sellerType: classifySeller(null) as any,
        city: local?.city ?? null,
        state: local?.uf ?? null,
        photos: foto ? [foto] : [],
        raw: { categoriaId: href[2] },
      });
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
