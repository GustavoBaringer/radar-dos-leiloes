import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const HOST = 'https://www.leiloesfreire.com.br';
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
function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/disputa|aberto|lance/.test(t)) return 'aberto';
  if (/encerrad|vendid|arrematad|cancelad/.test(t)) return 'encerrado';
  return 'sem_data';
}

export const leiloesfreire: Connector = {
  def: {
    id: 'leiloesfreire',
    name: 'Leilões Freire',
    platform: 'Leilões Freire Laravel',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Listagem /leiloes aponta eventos; página de evento traz cards com foto, título, preço e status.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    let home;
    try { home = await fetchText(`${HOST}/leiloes`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched, skipped, httpStatus }; }
    httpStatus = home.status;
    if (home.status !== 200) return { lots, fetched, skipped, httpStatus };
    const eventos = [...new Set([...home.body.matchAll(/href="https:\/\/www\.leiloesfreire\.com\.br\/leilao\/(\d+)"/g)].map((m) => m[1]))].slice(0, 6);
    for (const ev of eventos) {
      if (lots.length >= limit) break;
      let r;
      try { r = await fetchText(`${HOST}/leilao/${ev}`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { continue; }
      httpStatus = r.status;
      if (r.status !== 200) continue;
      const dataEvento = dataBr(r.body.match(/\d{2}\/\d{2}\/\d{4}\s+às\s+\d{2}:\d{2}/)?.[0]);
      for (const m of r.body.matchAll(/<article class="single_product">([\s\S]*?)<\/article>/g)) {
        if (lots.length >= limit) break;
        const corte = m[1];
        const href = corte.match(/href="https:\/\/www\.leiloesfreire\.com\.br\/leilao\/lote\/(\d+)"/)?.[1];
        if (!href || vistos.has(href)) continue;
        vistos.add(href);
        fetched++;
        const titulo = strip(corte.match(/<div class="leilao_titulo">([\s\S]*?)<\/div>/)?.[1] ?? '');
        if (!titulo || looksLikePart(titulo)) { skipped++; continue; }
        const foto = corte.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
        const statusTxt = strip(corte.match(/<div class="leilao_situacao[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
        const parsed = parseTitle(titulo);
        const local = campos.localDeTexto(titulo);
        lots.push({
          sourceId: 'leiloesfreire',
          externalId: href,
          lotUrl: `${HOST}/leilao/lote/${href}`,
          auctioneerName: 'Leilões Freire',
          titleRaw: titulo,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          assetType: parsed.brand ? 'veiculo' : /im[óo]vel|apartamento|casa|terreno/i.test(titulo) ? 'imovel' : 'outro',
          closingModel: 'pregao_em_horario',
          auctionEndUtc: dataEvento,
          sourceTz: 'America/Sao_Paulo',
          status: statusDe(statusTxt),
          minBid: dinheiro(corte.match(/current_price">\s*R\$\s*([\d.,]+)/)?.[1]),
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto] : [],
          raw: { evento: ev, statusTexto: statusTxt },
        });
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
