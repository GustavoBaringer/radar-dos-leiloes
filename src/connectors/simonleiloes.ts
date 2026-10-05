import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const HOST = 'https://www.simonleiloes.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/<!-- -->/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
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
function foto(corte: string): string | null {
  const raw = corte.match(/url=([^&"]+)/)?.[1];
  return raw ? decodeURIComponent(raw) : null;
}

export const simonleiloes: Connector = {
  def: {
    id: 'simonleiloes',
    name: 'Simon Leilões',
    platform: 'Simon Next.js',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home/listagens SSR do Next com cards de lotes, fotos S3, lance inicial e datas de praça.',
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
    for (const m of r.body.matchAll(/href="(\/lotes\/([^"]+?)-(\d+))"([\s\S]*?)(?=href="\/lotes\/|<footer|$)/g)) {
      if (lots.length >= limit) break;
      const [, href, slug, id, corte] = m;
      if (vistos.has(id)) continue;
      vistos.add(id);
      fetched++;
      const h2 = strip(corte.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '');
      const categoria = strip(corte.match(/categories--item[\s\S]*?<!-- -->\s*([^<]+)<\/span>/)?.[1] ?? '');
      const titulo = h2 || slug.replace(/-/g, ' ');
      if (!titulo || looksLikePart(titulo)) { skipped++; continue; }
      const datas = [...corte.matchAll(/(\d{2}\/\d{2}\/\d{4}\s+às\s+\d{2}:\d{2})/g)].map((x) => x[1]);
      const lances = [...corte.matchAll(/R\$\s*([\d.,]+)/g)].map((x) => dinheiro(x[1])).filter((n): n is number => !!n);
      const parsed = parseTitle(titulo);
      const local = campos.localDeTexto(titulo);
      lots.push({
        sourceId: 'simonleiloes',
        externalId: id,
        lotUrl: `${HOST}${href}`,
        auctioneerName: 'Simon Leilões',
        titleRaw: titulo,
        brand: parsed.brand,
        model: parsed.model,
        version: parsed.version,
        yearMake: parsed.yearMake,
        yearModel: parsed.yearModel,
        assetType: /im[óo]vel|terreno|frigor[íi]fico/i.test(categoria + ' ' + titulo) ? 'imovel' : parsed.brand || /autom[óo]vel|moto|caminh/i.test(categoria) ? 'veiculo' : 'outro',
        sourceCategory: categoria || null,
        closingModel: 'timer_por_lote',
        auctionStartUtc: dataBr(datas[0]),
        auctionEndUtc: dataBr(datas[datas.length - 1]) ?? dataBr(datas[0]),
        sourceTz: 'America/Sao_Paulo',
        status: /Recebendo lances/i.test(corte) ? 'aberto' : 'sem_data',
        minBid: lances[lances.length - 1] ?? lances[0] ?? null,
        sellerType: classifySeller(null) as any,
        city: local?.city ?? null,
        state: local?.uf ?? null,
        photos: foto(corte) ? [foto(corte)!] : [],
        raw: { categoria },
      });
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
