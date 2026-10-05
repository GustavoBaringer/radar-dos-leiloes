import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';

const HOST = 'https://globoleiloes.com.br';
// Mesmo objeto no CDN vive em DUAS árvores e só uma delas responde 200: os lotes
// do marketplace (partner_id preenchido) estão em auctions/partners/lots, os
// próprios em auctions/lots/images. Medido nos dois sentidos — pedir a árvore
// errada devolve AccessDenied 403. Por isso tentamos as duas, nesta ordem.
const CDN_ARVORES = [
  'https://d1etsb4iun2r36.cloudfront.net/auctions/lots/images',
  'https://d1etsb4iun2r36.cloudfront.net/auctions/partners/lots',
];

/** Primeiro candidate que a origem confirma com 200 e tipo de imagem. */
async function fotoNoCdn(img: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(img)) return cache.get(img)!;
  for (const base of CDN_ARVORES) {
    const u = `${base}/thumb_${img}`;
    try {
      const res = await fetch(u, { headers: { 'user-agent': UA, referer: `${HOST}/` }, signal: AbortSignal.timeout(12000) });
      const ct = res.headers.get('content-type') ?? '';
      await res.arrayBuffer();
      if (res.status === 200 && ct.startsWith('image/')) {
        cache.set(img, u);
        return u;
      }
    } catch {
      // tenta a próxima árvore
    }
  }
  cache.set(img, null);
  return null;
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function decode(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");
}
function itens(props: any): any[] {
  return [...(props.openLots ?? []), ...(props.highlightedLots ?? [])];
}

export const globoleiloes: Connector = {
  def: {
    id: 'globoleiloes',
    name: 'Globo Leilões',
    platform: 'Globo Leilões Inertia',
    method: 'json-embedded',
    tier: 3,
    siteUrl: HOST,
    notes: 'Inertia data-page na home contém openLots/highlightedLots com imagens, valores e datas.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let httpStatus = 0;
    let r;
    try { r = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched: 0, skipped: 0, httpStatus }; }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched: 0, skipped: 0, httpStatus };
    const raw = r.body.match(/data-page="([^"]+)/)?.[1];
    if (!raw) return { lots, fetched: 0, skipped: 0, httpStatus, note: 'sem data-page' };
    const props = JSON.parse(decode(raw)).props;
    let fetched = 0;
    // Foto é resolvida por sondagem (uma requisição por lote, no máximo), então
    // fica fora do laço: o push do lote só espera o resultado.
    const candidatos = itens(props).filter((l: any) => l?.id).map((l: any) => [String(l.id), l.images?.[0]?.name ?? l.photo ?? null] as const);
    const cacheFoto = new Map<string, string | null>();
    const fotosPorLote = new Map<string, string | null>();
    for (const [id, img] of candidatos) {
      fotosPorLote.set(id, img ? await fotoNoCdn(img, cacheFoto) : null);
    }
    for (const l of itens(props)) {
      if (lots.length >= limit) break;
      if (!l?.id || vistos.has(String(l.id))) continue;
      vistos.add(String(l.id));
      fetched++;
      const vals = Array.isArray(l.values) ? l.values : [];
      const vigente = vals.find((v: any) => v.status === 1) ?? vals[vals.length - 1] ?? null;
      const img = l.images?.[0]?.name ?? l.photo ?? null;
      const titulo = [l.title, l.city && l.uf ? `${l.city}/${l.uf}` : null].filter(Boolean).join(' - ');
      const cat = l.subcategory?.name ?? l.category?.name ?? null;
      lots.push({
        sourceId: 'globoleiloes',
        externalId: String(l.id),
        lotUrl: l.url?.startsWith('http') ? l.url : `${HOST}/leiloes/${l.slug}/${l.id}`,
        auctioneerName: 'Globo Leilões',
        titleRaw: titulo || String(l.slug ?? l.id),
        assetType: /ve[ií]culo|carro|moto|caminh/i.test(cat ?? '') ? 'veiculo' : 'imovel',
        sourceCategory: cat,
        closingModel: 'timer_por_lote',
        auctionStartUtc: vigente?.start ? new Date(vigente.start) : null,
        auctionEndUtc: vigente?.end ? new Date(vigente.end) : null,
        sourceTz: 'America/Sao_Paulo',
        status: l.status === 1 ? 'aberto' : 'sem_data',
        minBid: dinheiro(vigente?.price),
        appraisal: dinheiro(l.avaliation),
        sellerType: classifySeller(null) as any,
        city: l.city ? campos.apararCidade(l.city) : null,
        state: l.uf && campos.ehUf(l.uf) ? l.uf : null,
        photos: fotosPorLote.get(String(l.id)) ? [fotosPorLote.get(String(l.id))!] : [],
        raw: { partnerId: l.partner_id },
      });
    }
    return { lots, fetched, skipped: fetched - lots.length, httpStatus };
  },
};
