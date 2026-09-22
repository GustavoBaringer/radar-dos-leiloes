import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * LEILOTECH — 1 domínio só (topoleiloes.com.br), catálogo pequeno (~12 lotes
 * medido em 22/09). Sem paginação na `/agenda`: é tudo o que o tenant tem.
 *
 * A listagem NÃO traz preço nem status por item — só a página de detalhe tem
 * o `<dl>` com Status/Categoria/Avaliação. Com 12 lotes, 1 requisição por
 * lote é barato; não compensaria numa fonte grande.
 *
 * Sem campo de lance (nem "Lance Inicial" nem "Lance Atual") em nenhuma das
 * páginas testadas — só Avaliação. Lance fica null de propósito.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='leilotech' AND http_status=200 LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
}

function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/ativo|aberto/.test(t)) return 'aberto';
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/encerrad|cancelad|suspens/.test(t)) return 'encerrado';
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function lerDl(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>([^<]*)<\/dd>/gi)) {
    out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

export const leilotech: Connector = {
  def: {
    id: 'leilotech',
    name: 'Plataforma Leilotech',
    platform: 'Leilotech',
    method: 'html',
    tier: 4,
    siteUrl: 'https://topoleiloes.com.br',
    notes: '1 tenant conhecido, catálogo pequeno. Detalhe do lote (não a listagem) tem status/categoria/avaliação num <dl>. Sem campo de lance.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.LEILOTECH_TENANTS ?? 5));

    for (const host of dominios) {
      let r;
      try {
        r = await fetchText(`https://${host}/agenda`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const vistos = new Set<string>();
      const links: Array<{ id: string; slug: string; titulo: string }> = [];
      for (const m of r.body.matchAll(/href="\/lote\/(\d+)\/([^"]+)"[^>]*>([^<]+)</g)) {
        if (vistos.has(m[1])) continue;
        vistos.add(m[1]);
        links.push({ id: m[1], slug: m[2], titulo: m[3].replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim() });
      }
      fetched += links.length;

      for (const l of links) {
        if (lots.length >= limit) break;
        if (!l.titulo || looksLikePart(l.titulo)) {
          skipped++;
          continue;
        }
        let dr;
        try {
          dr = await fetchText(`https://${host}/lote/${l.id}/${l.slug}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        } catch {
          skipped++;
          continue;
        }
        if (dr.status !== 200) {
          skipped++;
          continue;
        }
        const dl = lerDl(dr.body);
        const parsed = parseTitle(l.titulo);
        const local = campos.localDeTexto(l.titulo);
        const foto = dr.body.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;

        lots.push({
          sourceId: 'leilotech',
          externalId: `${host}:${l.id}`,
          lotUrl: `https://${host}/lote/${l.id}/${l.slug}`,
          titleRaw: l.titulo,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          sourceCategory: dl.categoria ?? null,
          // "Categoria" no <dl> vem vazia ou genérica na maioria dos lotes
          // medidos (endereço claramente imóvel, categoria="outro" mesmo
          // assim) — o título discrimina melhor: marca reconhecida por
          // parseTitle é sinal forte de veículo, palavra de imóvel no título
          // vale mais que o campo da fonte.
          assetType: /im[óo]vel|apartamento|casa|sobrado|terreno|sala\s+comercial|barrac[ãa]o|fra[çc][ãa]o\s+ideal|vaga\s+de\s+garagem/i.test(
            `${dl.categoria ?? ''} ${l.titulo}`,
          )
            ? 'imovel'
            : /ve[íi]culo/i.test(dl.categoria ?? '') || parsed.brand
              ? 'veiculo'
              : 'outro',
          closingModel: 'sequencial',
          auctionStartUtc: null,
          auctionEndUtc: null,
          sourceTz: 'America/Sao_Paulo',
          status: dl.status ? statusDe(dl.status) : 'sem_data',
          appraisal: dinheiro(dl['avaliação']),
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto] : [],
          raw: { tenant: host, dl },
        });
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
