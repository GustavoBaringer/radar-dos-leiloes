import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://www.flexleiloes.com.br';

function texto(html: string) { return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})h(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}
function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/suspens|cancelad|encerrad|finalizad/.test(t)) return 'encerrado';
  if (/lances a partir/.test(t)) return 'agendado';
  if (/aberto|lance/.test(t)) return 'aberto';
  return 'sem_data';
}

export const flexleiloes: Connector = {
  def: {
    id: 'flexleiloes',
    name: 'FlexLeilões',
    platform: 'FlexLeilões',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home server-rendered com cards de lotes; coleta título, foto, data e lance mínimo direto da listagem.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    let r;
    try { r = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched, skipped, httpStatus }; }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched, skipped, httpStatus };

    for (const bloco of r.body.split('<a href="lotes/').slice(1)) {
      if (lots.length >= limit) break;
      const id = bloco.match(/^(\d+)/)?.[1];
      if (!id) continue;
      fetched++;
      const corte = bloco.slice(0, 2600);
      const titulo = texto(corte.match(/<h2 class="item-titulo">([\s\S]*?)<\/h2>/)?.[1] ?? '');
      if (!titulo || looksLikePart(titulo)) { skipped++; continue; }
      const desc = corte.match(/<div class="item-descricao">([\s\S]*?)<\/div>/)?.[1] ?? '';
      const datas = [...desc.matchAll(/\d[º°]? LEILÃO:\s*(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}h\d{2})/gi)].map((m) => m[1]);
      const lances = [...desc.matchAll(/Lance Mínimo:\s*R\$\s*([\d.,]+)/gi)].map((m) => dinheiro(m[1])).filter((n): n is number => !!n);
      const andamento = texto(corte.match(/<div class="item-andamento">([\s\S]*?)<\/div>/)?.[1] ?? '');
      const foto = corte.match(/<img[^>]+src=([^\s>]+)/)?.[1] ?? null;
      const parsed = parseTitle(titulo);
      const local = campos.localDeTexto(titulo);
      lots.push({
        sourceId: 'flexleiloes',
        externalId: id,
        lotUrl: `${HOST}/lotes/${id}`,
        auctioneerName: 'FlexLeilões',
        titleRaw: titulo,
        brand: parsed.brand,
        model: parsed.model,
        version: parsed.version,
        yearMake: parsed.yearMake,
        yearModel: parsed.yearModel,
        assetType: /im[óo]vel|apartamento|casa|terreno|garagem/i.test(titulo) ? 'imovel' : parsed.brand ? 'veiculo' : 'outro',
        closingModel: 'timer_por_lote',
        auctionStartUtc: dataBr(datas[0]),
        auctionEndUtc: dataBr(datas[datas.length - 1]) ?? dataBr(datas[0]),
        sourceTz: 'America/Sao_Paulo',
        status: statusDe(andamento),
        minBid: lances[lances.length - 1] ?? lances[0] ?? null,
        sellerType: classifySeller(null) as any,
        city: local?.city ?? null,
        state: local?.uf ?? null,
        photos: foto ? [foto.startsWith('http') ? foto : `${HOST}/${foto.replace(/^\//, '')}`] : [],
        raw: { andamento },
      });
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
