import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const HOST = 'https://www.casadeleiloes.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function strip(v: string) { return v.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

export const casadeleiloes: Connector = {
  def: {
    id: 'casadeleiloes',
    name: 'Casa de Leilões',
    platform: 'Casa de Leilões ASP.NET',
    method: 'html',
    tier: 3,
    siteUrl: HOST,
    notes: 'Home lista eventos e cada evento lista lotes server-rendered; valores/datas ficam no detalhe, não coletados nesta primeira versão.',
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
    const eventos = [...new Set([...home.body.matchAll(/['"](\/leilao\/[^'"]+\/\d+)['"]/g)].map((m) => m[1]))].slice(0, 8);
    for (const ev of eventos) {
      if (lots.length >= limit) break;
      let r;
      try { r = await fetchText(`${HOST}${ev}`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { continue; }
      httpStatus = r.status;
      if (r.status !== 200) continue;
      for (const m of r.body.matchAll(/<a class="lote-lista"[\s\S]*?<\/a>/g)) {
        if (lots.length >= limit) break;
        const corte = m[0].slice(0, 3000);
        const href = corte.match(/href=['"](\/lote\/[^'"]+\/(\d+))['"]/)?.[1];
        const id = href?.match(/\/(\d+)$/)?.[1];
        if (!href || !id || vistos.has(id)) continue;
        vistos.add(id);
        fetched++;
        const titulo = strip(corte.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1] ?? '');
        if (!titulo || looksLikePart(titulo)) { skipped++; continue; }
        const fotoRaw = corte.match(/data-src=['"]([^'"]+)['"]/)?.[1]
          ?? corte.match(/<img[^>]+src=['"]([^'"]+)['"]/)?.[1]
          ?? null;
        const foto = fotoRaw && !/\/imagens\/tr\.gif$/i.test(fotoRaw) ? fotoRaw : null;
        const parsed = parseTitle(titulo);
        const local = campos.localDeTexto(titulo);
        lots.push({
          sourceId: 'casadeleiloes',
          externalId: id,
          lotUrl: `${HOST}${href}`,
          auctioneerName: 'Casa de Leilões',
          titleRaw: titulo,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          assetType: /im[óo]vel|apartamento|casa|terreno|fazenda/i.test(titulo) ? 'imovel' : parsed.brand ? 'veiculo' : 'outro',
          closingModel: 'pregao_em_horario',
          sourceTz: 'America/Sao_Paulo',
          status: 'sem_data',
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto.startsWith('http') ? foto : `${HOST}${foto}`] : [],
          raw: { evento: ev },
        });
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
