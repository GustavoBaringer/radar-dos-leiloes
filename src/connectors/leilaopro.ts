import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import { parseTitle, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';
import * as campos from '../core/campos.js';

/**
 * Plataforma white-label Leilão PRO: um conector para N leiloeiros.
 * 103 domínios identificados na descoberta.
 *
 * Diferente da SOLEON, aqui a DATA DO PREGÃO vem no próprio card da listagem
 * (`.info-meta`), então não é preciso abrir o detalhe de cada lote para ter data.
 *
 * O lance atual NÃO está no HTML servido: `.bid-current` é injetado por JS via
 * websocket. O que o servidor entrega é `.bid-initial`, então o valor lido é o
 * lance inicial — e é assim que ele entra, não como lance atual.
 */

const CATEGORIAS: Array<{ path: string; asset: AssetType; grupo?: string }> = [
  { path: 'veiculos', asset: 'veiculo' },
  { path: 'maquinas', asset: 'veiculo', grupo: 'maquina' },
  { path: 'imoveis', asset: 'imovel' },
];

const MESES_OK = /^\d{2}\/\d{2}\/\d{4}$/;

/** "QUA. 16/09/2026 10:00" -> Date em UTC (a fonte publica em horário de Brasília). */
function dataDoCard(texto: string): Date | null {
  const d = texto.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1];
  const h = texto.match(/(\d{2}):(\d{2})/);
  if (!d || !MESES_OK.test(d)) return null;
  const [dia, mes, ano] = d.split('/').map(Number);
  const dt = new Date(Date.UTC(ano, mes - 1, dia, (h ? Number(h[1]) : 0) + 3, h ? Number(h[2]) : 0));
  return isNaN(dt.getTime()) ? null : dt;
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'leilao-pro' AND http_status = 200 AND has_lots IS NOT FALSE
      ORDER BY auctioneers DESC, domain
      LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
}

export const leilaopro: Connector = {
  def: {
    id: 'leilaopro',
    name: 'Plataforma Leilão PRO',
    platform: 'Leilão PRO',
    method: 'html',
    tier: 2,
    siteUrl: 'https://www.leilao.pro',
    notes: 'White-label multi-tenant. Rotas /leilao/lotes/{veiculos|maquinas|imoveis}. Data do pregão vem no card; lance atual só via JS.',
  },
  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.LEILAOPRO_TENANTS ?? 12));
    const cats = CATEGORIAS.filter((c) => !assetTypes || assetTypes.includes(c.asset));
    const cota = Math.max(20, Math.ceil(limit / Math.max(1, dominios.length)));
    const vistos = new Set<string>();

    for (const host of dominios) {
      const antes = lots.length;
      for (const cat of cats) {
        if (lots.length - antes >= cota || lots.length >= limit) break;
        let res;
        try {
          res = await fetchText(`https://${host}/leilao/lotes/${cat.path}`, { gapMs: 1100 });
        } catch {
          continue;
        }
        httpStatus = res.status;
        if (res.status !== 200) continue;

        const $ = cheerio.load(res.body);
        const cards = $('.card-vertical').toArray();
        fetched += cards.length;

        for (const el of cards) {
          if (lots.length - antes >= cota || lots.length >= limit) break;
          const $c = $(el);
          const href = $c.find('a[href*="/lote_id/"]').first().attr('href') ?? '';
          const id = href.match(/\/lote_id\/(\d+)/)?.[1];
          if (!id) continue;

          const chave = `${host}:${id}`;
          if (vistos.has(chave)) continue; // o mesmo lote aparece em mais de uma categoria
          vistos.add(chave);

          const titulo = $c.find('h5.card-title').text().replace(/\s+/g, ' ').trim();
          const nomeLeilao = $c.find('.info-title').text().replace(/\s+/g, ' ').trim() || null;
          if (!titulo || (cat.asset === 'veiculo' && looksLikePart(titulo))) {
            skipped++;
            continue;
          }

          const inicio = dataDoCard($c.find('.info-meta').text().replace(/\s+/g, ' '));
          const rotulo = $c.find('.bid-label').first().text();
          const valor = dinheiro($c.find('.bid-value').first().text());
          const parsed =
            cat.asset === 'veiculo'
              ? parseTitle(titulo)
              : { brand: null, model: null, version: null, yearMake: null, yearModel: null };

          const status: LotStatus = inicio ? (inicio.getTime() > Date.now() ? 'agendado' : 'aberto') : 'sem_data';

          lots.push({
            // O leilão nomeia a cidade ("IMÓVEIS EM URUGUAIANA/RS") mais vezes
            // que o título; a URL vem por último porque é derivada e traz o
            // tipo do bem colado no slug.
            ...(campos.localDeTexto(nomeLeilao) ??
                campos.localDeTexto(titulo) ??
                campos.localDeTexto(href) ??
                { city: null, state: null } as any),
            sourceId: 'leilaopro',
            externalId: chave,
            lotUrl: href.startsWith('http') ? href : `https://${host}${href}`,
            titleRaw: titulo,
            assetType: cat.asset,
            sourceGroup: cat.grupo ?? (cat.asset === 'imovel' ? 'imovel' : null),
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            // A fonte publica só a hora de início do pregão, sem término por lote.
            closingModel: 'pregao_em_horario',
            auctionStartUtc: inicio,
            auctionEndUtc: null,
            sourceTz: 'America/Sao_Paulo',
            status,
            // `.bid-current` é injetado por JS; o HTML servido traz o inicial.
            currentBid: /atual/i.test(rotulo) ? valor : null,
            minBid: /atual/i.test(rotulo) ? null : valor,
            auctioneerName: null,
            sellerName: null,
            photos: [$c.find('.card-image img').attr('src')].filter((p): p is string => Boolean(p)),
            raw: {
              tenant: host,
              loteId: id,
              lote: $c.find('.badge-primary').first().text().replace(/\s+/g, ' ').trim() || null,
              leilao: $c.find('.info-title').text().replace(/\s+/g, ' ').trim() || null,
              categoria: cat.path,
            },
          });
        }
      }
      if (lots.length >= limit) break;
    }

    return { lots, fetched, skipped, httpStatus };
  },
};
