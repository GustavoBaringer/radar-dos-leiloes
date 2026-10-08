import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const HOST = 'https://www.grupocarvalholeiloes.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function tituloDoSlug(slug: string) {
  return decodeURIComponent(slug).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}
function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function statusDe(html: string): LotStatus {
  if (/Encerrado|encerrado/i.test(html)) return 'encerrado';
  if (/Aberto|Em andamento|Dou-lhe|Lance mínimo/i.test(html)) return 'aberto';
  return 'sem_data';
}

export const grupocarvalho: Connector = {
  def: {
    id: 'grupocarvalho',
    name: 'Grupo Carvalho Leilões',
    platform: 'Grupo Carvalho Next.js',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home lista leilões e páginas de leilão listam lotes em HTML/flight data; parser usa links de lote e lance mínimo próximo quando disponível.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    let home;
    try { home = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched, skipped, httpStatus }; }
    httpStatus = home.status;
    if (home.status !== 200) return { lots, fetched, skipped, httpStatus };
    const eventos = [...new Set([...home.body.matchAll(/href="(leilao\/[^"]+\/\d+)"/g)].map((m) => `/${m[1]}`))].slice(0, 8);
    for (const ev of eventos) {
      if (lots.length >= limit) break;
      let r;
      try { r = await fetchText(`${HOST}${ev}`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { continue; }
      httpStatus = r.status;
      if (r.status !== 200) continue;
      const status = statusDe(r.body);
      for (const m of r.body.matchAll(/href="(?:https:\/\/www\.grupocarvalholeiloes\.com\.br)?\/lote\/([^"/]+)\/(\d+)"/g)) {
        if (lots.length >= limit) break;
        const [, slug, id] = m;
        if (vistos.has(id)) continue;
        vistos.add(id);
        fetched++;
        const titulo = tituloDoSlug(slug);
        if (!titulo || looksLikePart(titulo)) { skipped++; continue; }
        const pos = m.index ?? 0;
        const perto = r.body.slice(pos, pos + 1800);
        const minBid = dinheiro(perto.match(/Lance mínimo:.*?R\$\s*([\d.,]+)/i)?.[1]);
        const foto = perto.match(/https:\/\/midias-plataforma\.s3[^"\\<]+/)?.[0]?.replace(/\\u0026/g, '&') ?? null;
        const parsed = parseTitle(titulo);
        const local = campos.localDeTexto(titulo);
        lots.push({
          sourceId: 'grupocarvalho',
          externalId: id,
          lotUrl: `${HOST}/lote/${slug}/${id}`,
          auctioneerName: 'Grupo Carvalho Leilões',
          titleRaw: titulo,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          assetType: parsed.brand || /veiculo|sucata|documento|placa/i.test(titulo) ? 'veiculo' : 'outro',
          closingModel: 'pregao_em_horario',
          sourceTz: 'America/Sao_Paulo',
          status,
          minBid,
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto] : [],
          raw: { evento: ev },
        });
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
