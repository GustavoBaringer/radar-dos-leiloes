import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';

const HOST = 'https://www.alfaleiloes.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+às\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}
function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/vendid|encerrad|cancelad|suspens/.test(t)) return 'encerrado';
  if (/aberto/.test(t)) return 'aberto';
  if (/futuro|breve|aguarda/.test(t)) return 'agendado';
  return 'sem_data';
}
function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

export const alfaleiloes: Connector = {
  def: {
    id: 'alfaleiloes',
    name: 'Alfa Leilões',
    platform: 'Alfa Leilões',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home server-rendered com cards de lotes em destaque; coleta título, foto, praças e lance mínimo.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    let r;
    try { r = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched, skipped, httpStatus }; }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched, skipped, httpStatus };

    for (const bloco of r.body.split('class="home-leiloes-cards"').slice(1)) {
      if (lots.length >= limit) break;
      const corte = bloco.slice(0, 4500);
      const href = corte.match(/href="(\/lote\/(\d+)\/[^"]+)"/)?.[1];
      const id = corte.match(/\/lote\/(\d+)\//)?.[1];
      if (!href || !id || vistos.has(id)) continue;
      vistos.add(id);
      fetched++;
      const titulo = strip(corte.match(/<div class="card-content[^"]*">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
      if (!titulo) { skipped++; continue; }
      const foto = corte.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
      const docType = strip(corte.match(/card-content-judicial[\s\S]{0,120}<p>([^<]+)<\/p>/)?.[1] ?? '').toLowerCase() || null;
      const datas = [...corte.matchAll(/(\d{2}\/\d{2}\/\d{4}\s+às\s+\d{2}:\d{2})/g)].map((m) => m[1]);
      const lances = [...corte.matchAll(/<span js-money[^>]*>\s*([\d.,]+)\s*<\/span>/g)].map((m) => dinheiro(m[1])).filter((n): n is number => !!n);
      const statusTxt = strip(corte.match(/card-status[\s\S]{0,120}<p>([^<]+)<\/p>/)?.[1] ?? '');
      const local = campos.localDeTexto(titulo);
      lots.push({
        sourceId: 'alfaleiloes',
        externalId: id,
        lotUrl: `${HOST}${href}`,
        auctioneerName: 'Alfa Leilões',
        titleRaw: titulo,
        assetType: 'imovel',
        docType,
        closingModel: 'timer_por_lote',
        auctionStartUtc: dataBr(datas[0]),
        auctionEndUtc: dataBr(datas[datas.length - 1]) ?? dataBr(datas[0]),
        sourceTz: 'America/Sao_Paulo',
        status: statusDe(statusTxt),
        minBid: lances[lances.length - 1] ?? lances[0] ?? null,
        sellerType: classifySeller(null) as any,
        city: local?.city ?? null,
        state: local?.uf ?? null,
        photos: foto ? [foto] : [],
        raw: { statusTexto: statusTxt },
      });
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
