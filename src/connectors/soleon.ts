import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * Plataforma white-label SOLEON: um conector para N leiloeiros.
 * 107 domínios identificados na descoberta, 63 com lote publicado.
 *
 * O que torna isso barato é a rota GLOBAL de veículos, que atravessa todos os
 * leilões do tenant e já vem tipada pela própria plataforma:
 *   /lotes/veiculo?tipo=veiculo&page=N
 * Não confundir com /lotes/categoria/*, que dá 500 em alguns tenants e devolve
 * 1 lote onde a rota certa devolve 211.
 *
 * Armadilhas tratadas:
 *  - O host sai SEMPRE do href: um tenant serve leilão hospedado em outro domínio.
 *  - No layout B a foto é `background: url()` no atributo style, não <img>.
 *  - A paginação vem duplicada no DOM (desktop + mobile): desduplicar.
 *  - `class='ativo label_leilao'` usa aspas simples; seletor por atributo resolve.
 *  - A descrição traz placa, RENAVAM e NOME DE EXECUTADO. O bloco judicial é
 *    removido antes de o texto virar título, e o scrub de placa faz o resto.
 */

const LOTES_POR_PAGINA = 30;

/** Remove o bloco judicial: são nomes de pessoas físicas, não do produto. */
function semPartesJudiciais(texto: string): string {
  return texto
    .replace(/\b(Exequente|Executado|Autor|Réu|Reu|Requerente|Requerido)\s*:.*$/gim, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function statusDe(classes: string): LotStatus {
  if (/aberto_lance/.test(classes)) return 'aberto';
  if (/aguarde_abertura/.test(classes)) return 'agendado';
  if (/vendido/.test(classes)) return 'vendido';
  if (/sustado|encerrad/.test(classes)) return 'encerrado';
  return 'sem_data';
}

interface Card {
  itemId: string;
  url: string;
  lote: string | null;
  titulo: string;
  foto: string | null;
  status: LotStatus;
  rotuloValor: string | null;
  valor: number | null;
  corpo: string;
}

function lerCards($: cheerio.CheerioAPI, host: string): Card[] {
  const out: Card[] = [];
  $('div.lote').each((_, el) => {
    const $c = $(el);
    const href = $c.find('a[href*="/item/"]').first().attr('href') ?? '';
    const m = href.match(/\/item\/(\d+)\/detalhes/);
    if (!m) return;

    // Layout A usa <img>; layout B esconde a foto no style do link.
    const style = $c.find('a[style*="background"]').first().attr('style') ?? '';
    const foto = $c.find('.image-lote img').attr('src') ?? style.match(/url\(['"]?([^'")]+)/)?.[1] ?? null;

    // O <h5> costuma trazer só a CATEGORIA ("CAMINHONETE", "AUTOMÓVEL"); a
    // descrição é que tem marca, modelo e ano. Usa a descrição quando existir.
    const descricao = $c
      .find('div[style*="justify"]')
      .first()
      .text()
      .replace(/^\s*Descri[çc][ãa]o\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const h5 = $c.find('h5').first().text().replace(/\s+/g, ' ').trim();
    const titulo = (descricao.length > h5.length ? descricao : h5 || descricao).slice(0, 180);
    const bloco = $c.find('[class*="label_lote"]').first();
    const rotulo = $c.find('.etiqueta').first().text().trim() || $c.find('.my-auto h5').first().text().trim() || null;
    const valorTxt = $c.find('.lance').first().text().trim() || $c.find('.my-auto h4').first().text().trim();

    out.push({
      itemId: m[1],
      url: href.startsWith('http') ? href : `https://${host}${href}`,
      lote: $c.find('h4').first().text().match(/Lote\s*([\w.-]+)/i)?.[1] ?? null,
      titulo,
      foto,
      status: statusDe(bloco.attr('class') ?? ''),
      rotuloValor: rotulo,
      valor: dinheiro(valorTxt),
      corpo: $c.text().replace(/\s+/g, ' ').trim(),
    });
  });
  return out;
}

async function tenants(limitTenants: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'soleon' AND http_status = 200 AND has_lots IS NOT FALSE
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC
      LIMIT $1`,
    [limitTenants],
  );
  return rows.map((r) => r.domain);
}

export const soleon: Connector = {
  def: {
    id: 'soleon',
    name: 'Plataforma SOLEON',
    platform: 'SOLEON',
    method: 'html',
    tier: 2,
    siteUrl: 'https://www.soleon.com.br',
    notes: 'White-label multi-tenant. Rota global /lotes/veiculo por tenant. 1 req/s por host; a lista de tenants vem de discovered_sites.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.SOLEON_TENANTS ?? 12));
    const cota = Math.max(LOTES_POR_PAGINA, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      const antes = lots.length;
      for (let page = 1; lots.length - antes < cota && lots.length < limit; page++) {
        let res;
        try {
          res = await fetchText(`https://${host}/lotes/veiculo?tipo=veiculo&page=${page}`, { gapMs: 1100 });
        } catch {
          break;
        }
        httpStatus = res.status;
        if (res.status !== 200) break;

        const $ = cheerio.load(res.body);
        const cards = lerCards($, host);
        if (!cards.length) break;
        fetched += cards.length;

        for (const c of cards) {
          const titulo = semPartesJudiciais(c.titulo || c.corpo.slice(0, 120));
          if (!titulo || looksLikePart(titulo)) {
            skipped++;
            continue;
          }
          const corpo = semPartesJudiciais(c.corpo);
          const parsed = parseTitle(titulo);
          // Janela fixa depois do rótulo: o endereço é longo e varia muito,
          // então recorta um trecho e procura "Cidade - UF" ou "Cidade/UF" dentro dele.
          const posLocal = corpo.search(/Local de Exposi[çc][ãa]o/i);
          const janela = posLocal >= 0 ? corpo.slice(posLocal, posLocal + 200) : '';
          const local = janela.replace(/^Local de Exposi[çc][ãa]o\s*:?\s*/i, '').split(/\s{2,}|Descri[çc]|Processo/)[0]?.trim() || null;
          // Dois formatos no mesmo campo: "Caçapava - SP" e "… Bairro X - Cidade - MG".
          const cidadeUf = janela.match(/([A-Za-zÀ-ú][A-Za-zÀ-ú\s.']{2,40}?)\s*[\/-]\s*([A-Z]{2})\b/);
          const km = Number(corpo.match(/\bKM\s*:?\s*([\d.]+)/i)?.[1]?.replace(/\./g, '')) || null;
          const maiorLance = /maior\s+lance/i.test(c.rotuloValor ?? '');

          lots.push({
            sourceId: 'soleon',
            externalId: `${host}:${c.itemId}`,
            lotUrl: c.url,
            titleRaw: titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*(\d{4})/i)?.[1]) || parsed.yearMake,
            yearModel: Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*\d{4}\s*\/\s*(\d{4})/i)?.[1]) || parsed.yearModel,
            km,
            color: corpo.match(/\bCOR\s+([A-Za-zÀ-ú]+)/i)?.[1] ?? null,
            fuel: corpo.match(/\b(diesel|flex|gasolina|[áa]lcool|el[ée]trico|h[íi]brido)\b/i)?.[1] ?? null,
            docType: /judicial|processo/i.test(corpo) ? 'judicial' : null,
            // Encerramento sequencial: o lote não tem timer próprio, e a data do
            // leilão só existe no detalhe. Sem detalhe, é honesto dizer sem data.
            closingModel: 'sequencial',
            auctionStartUtc: null,
            auctionEndUtc: null,
            sourceTz: 'America/Sao_Paulo',
            status: c.status,
            currentBid: maiorLance ? c.valor : null,
            minBid: maiorLance ? null : c.valor,
            auctioneerName: null,
            sellerName: null,
            sellerType: classifySeller(null) as any,
            city: cidadeUf?.[1]?.trim() ?? null,
            state: cidadeUf?.[2] ?? null,
            yard: local,
            photos: c.foto ? [c.foto] : [],
            raw: { tenant: host, itemId: c.itemId, lote: c.lote, rotuloValor: c.rotuloValor },
          });
        }
        if (cards.length < LOTES_POR_PAGINA) break;
      }
      if (lots.length >= limit) break;
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
