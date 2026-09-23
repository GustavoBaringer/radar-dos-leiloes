import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * PAULO BOTELHO — 112 lotes em `/lotes?page=N`, 12 por página.
 *
 * O domínio NU não conecta (falha de TLS reproduzida 3x); só com `www.`.
 * O card não tem rótulo de preço nem de status — o `<span>` solto antes do
 * título é o valor da praça vigente, e o status só existe no detalhe. As
 * duas praças vêm no texto ("1ª : dd/mm/aa hh:mm até ..."), e a data que
 * importa é o FIM da última.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://www.paulobotelholeiloeiro.com.br';

/** O site publica o título com entidade HTML crua ("UNIVERSIT&Aacute;RIAS"). */
function entidades(v: string): string {
  const mapa: Record<string, string> = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à', ordm: 'º', ordf: 'ª', amp: '&', nbsp: ' ' };
  return v
    .replace(/&([A-Za-z]+);/g, (todo, nome) => {
      const min = String(nome).toLowerCase();
      const c = mapa[min];
      if (!c) return todo;
      return nome[0] === nome[0].toUpperCase() && c.length === 1 ? c.toUpperCase() : c;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, aRaw, h, min] = m;
  const a = aRaw.length === 2 ? `20${aRaw}` : aRaw;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

export const paulobotelho: Connector = {
  def: {
    id: 'paulobotelho',
    name: 'Paulo Botelho Leiloeiro',
    platform: 'Paulo Botelho',
    method: 'html',
    tier: 4,
    siteUrl: HOST,
    notes: 'Listagem /lotes?page=N (12 por página). Domínio sem www NÃO conecta. Status só existe no detalhe; a listagem tem preço, endereço e as duas praças.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    for (let pagina = 1; lots.length < limit && pagina <= 12; pagina++) {
      let r;
      try {
        r = await fetchText(`${HOST}/lotes?page=${pagina}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        break;
      }
      httpStatus = r.status;
      if (r.status !== 200) break;

      const cards = r.body.split('class="featured-item col-md-4"').slice(1);
      if (!cards.length) break;
      fetched += cards.length;

      for (const bloco of cards) {
        if (lots.length >= limit) break;
        const corte = bloco.slice(0, 4000);
        const href = corte.match(/href="(\/leiloes\/[^"]+\/(\d+))"/);
        if (!href) continue;
        const id = href[2];
        if (vistos.has(id)) continue;
        vistos.add(id);

        const titulo = entidades(corte.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] ?? '');
        if (!titulo || looksLikePart(titulo)) {
          skipped++;
          continue;
        }
        // Datas das duas praças vêm em <strong> dentro do mesmo <p>; a última
        // é o fim da 2ª praça.
        const datas = [...corte.matchAll(/<strong>(\d{2}\/\d{2}\/\d{2,4}\s+\d{2}:\d{2})<\/strong>/g)].map((m) => m[1]);
        const local = campos.localDeTexto(titulo);
        const vara = corte.match(/color:#3d3d3d[^>]*>([^<]+)</)?.[1]?.trim() ?? null;
        const foto = corte.match(/<img src="([^"]+)"/)?.[1] ?? null;

        lots.push({
          sourceId: 'paulobotelho',
          externalId: id,
          lotUrl: `${HOST}${href[1]}`,
          titleRaw: titulo,
          assetType: /im[óo]vel|apartamento|casa|terreno|sala|galp[ãa]o|loja|vaga/i.test(titulo)
            ? 'imovel'
            : parseTitle(titulo).brand || /moto|caminh|autom|ve[íi]culo/i.test(titulo)
              ? 'veiculo'
              : 'outro',
          docType: vara && /vara|trabalho|justi/i.test(vara) ? 'judicial' : null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: dataBr(datas[0]),
          auctionEndUtc: dataBr(datas[datas.length - 1]),
          sourceTz: 'America/Sao_Paulo',
          // Sem rótulo de status na listagem; o relógio fecha pelo fim da praça.
          status: 'aberto',
          minBid: dinheiro(corte.match(/<span>\s*(R\$[^<]+)<\/span>/)?.[1]),
          auctioneerName: 'Paulo Botelho',
          sellerName: vara,
          sellerType: classifySeller(vara) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: foto ? [foto] : [],
          raw: { vara, processo: corte.match(/color:#2d2d2d[^>]*>([^<]+)</)?.[1]?.trim() ?? null },
        });
      }
      if (cards.length < 12) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
