import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';

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

    // A descrição é texto operacional/jurídico em muitos tenants (inclusive
    // Bidmax); só a use quando o h5 for a categoria genérica do bem.
    const descricao = $c
      .find('div[style*="justify"]')
      .first()
      .text()
      .replace(/^\s*Descri[çc][ãa]o\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const textoCard = $c.text().replace(/\s+/g, ' ').trim();
    const h5 = $c.find('h5').first().text().replace(/\s+/g, ' ').trim();
    const h5Generico = /^(ve[ií]culo|autom[oó]vel|carro|moto|motocicleta|caminhonete|caminh[aã]o|ônibus|onibus|utilit[aá]rio)$/i.test(h5);
    const marcaModelo = textoCard.match(/Marca\s*\/\s*Modelo\s*:\s*(.+?)(?=\s+(?:Placa|Ano|Cor|Combust[ií]vel)\s*:|$)/i)?.[1]?.trim() ?? '';
    const titulo = (!h5Generico && h5 ? h5 : marcaModelo || descricao).slice(0, 180);
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
      corpo: textoCard,
    });
  });
  return out;
}

async function tenants(limitTenants: number, tenant?: string): Promise<string[]> {
  const explicitos = String(process.env.SOLEON_DOMAINS ?? '').trim();
  if (explicitos) {
    const lista = explicitos.split(',').map((d) => d.trim()).filter(Boolean);
    if (!tenant) return lista;
    const apenas = filterTenantPopulation(lista, tenant);
    if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população explícita de SOLEON_DOMAINS`);
    return apenas;
  }
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'soleon' AND http_status = 200 AND has_lots IS NOT FALSE
       ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  const escolhidos = await dueTenants({ sourceId: 'soleon', candidates: rows.map((r) => r.domain), limit: tenant ? Number.MAX_SAFE_INTEGER : limitTenants, track: process.env.TENANT_LEDGER_ENABLED === '1' });
  if (!tenant) return escolhidos;
  const apenas = filterTenantPopulation(escolhidos, tenant);
  if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população elegível de soleon`);
  return apenas;
}

/**
 * O leiloeiro só existe no DETALHE do lote — não está na listagem nem no card,
 * e varia por leilão dentro do mesmo tenant (rico tem 4+), então não cabe cache
 * por domínio. O que salva o custo é que o leiloeiro de um lote NUNCA muda:
 * quem já tem nome no banco não é buscado de novo, e o regime permanente fica
 * sendo só os lotes novos.
 */
async function nomesJaConhecidos(): Promise<Map<string, string>> {
  const rows = await query<{ external_id: string; auctioneer_name: string }>(
    `SELECT external_id, auctioneer_name FROM lots
      WHERE source_id = 'soleon' AND auctioneer_name IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.external_id, r.auctioneer_name]));
}

async function lerLeiloeiro(url: string, observer?: import('../core/tenant-attempts.js').TenantAttempt): Promise<string | null> {
  try {
    const r = await fetchText(url, { gapMs: 1100, timeoutMs: 30000 });
    observer?.response(r.status);
    if (r.status !== 200) return null;
    return campos.nomeDeLeiloeiro(/LEILOEIRO OFICIAL<\/h5>\s*([^<]+)<br>/i.exec(r.body)?.[1]);
  } catch {
    observer?.failure('network');
    return null;
  }
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
  async collect({ limit, observer, tenant }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.SOLEON_TENANTS ?? 12), tenant);
    const conhecidos = await nomesJaConhecidos();
    const cota = Math.max(LOTES_POR_PAGINA, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      if (lots.length >= limit) break;
      const attempt = await observer?.start(host);
      const antes = lots.length;
      const fetchedAntes = fetched, skippedAntes = skipped;
      let truncated = false;
      try {
        for (let page = 1; lots.length - antes < cota && lots.length < limit; page++) {
          let res;
          try {
            res = await fetchText(`https://${host}/lotes/veiculo?tipo=veiculo&page=${page}`, { gapMs: 1100 });
          } catch {
            attempt?.failure('network');
            break;
          }
          attempt?.response(res.status);
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
            const posLocal = corpo.search(/Local de Exposi[çc][ãa]o/i);
            const janela = posLocal >= 0 ? corpo.slice(posLocal, posLocal + 200) : '';
            const CORTE_UI = /\s*(Aguarde|Aberto para|Encerrad|Lance Inicial|Maior Lance|Detalhes do Lote|Acompanhe ao Vivo)/i;
            const local = janela.replace(/^Local de Exposi[çc][ãa]o\s*:?\s*/i, '').split(/\s{2,}|Descri[çc]|Processo/)[0]?.split(CORTE_UI)[0]?.trim() || null;
            const cidadeUf = [...janela.matchAll(/([A-Za-zÀ-ú][A-Za-zÀ-ú\s.']{2,40}?)\s*[\/-]\s*([A-Z]{2})\b/g)].filter((m) => campos.ehUf(m[2])).pop();
            const km = Number(corpo.match(/\bKM\s*:?\s*([\d.]+)/i)?.[1]?.replace(/\./g, '')) || null;
            const maiorLance = /maior\s+lance/i.test(c.rotuloValor ?? '');
            const leiloeiro = conhecidos.get(`${host}:${c.itemId}`) ?? (await lerLeiloeiro(c.url, attempt));

            lots.push({
              sourceId: 'soleon', externalId: `${host}:${c.itemId}`, lotUrl: c.url, titleRaw: titulo,
              brand: parsed.brand, model: parsed.model, version: parsed.version,
              yearMake: Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*(\d{4})/i)?.[1]) || parsed.yearMake,
              yearModel: Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*\d{4}\s*\/\s*(\d{4})/i)?.[1]) || parsed.yearModel,
              km, color: corpo.match(/\bCOR\s+([A-Za-zÀ-ú]+)/i)?.[1] ?? null,
              fuel: corpo.match(/\b(diesel|flex|gasolina|[áa]lcool|el[ée]trico|h[íi]brido)\b/i)?.[1] ?? null,
              docType: /judicial|processo/i.test(corpo) ? 'judicial' : null,
              closingModel: 'sequencial', auctionStartUtc: null, auctionEndUtc: null,
              sourceTz: 'America/Sao_Paulo', status: c.status,
              currentBid: maiorLance ? c.valor : null, minBid: maiorLance ? null : c.valor,
              auctioneerName: leiloeiro, sellerName: null, sellerType: classifySeller(null) as any,
              city: cidadeUf ? campos.apararCidade(cidadeUf[1].trim()) || null : null,
              state: cidadeUf?.[2] ?? null, yard: local, photos: c.foto ? [c.foto] : [],
              raw: { tenant: host, itemId: c.itemId, lote: c.lote, rotuloValor: c.rotuloValor },
            });
          }
          if (cards.length < LOTES_POR_PAGINA) break;
          if (lots.length - antes >= cota || lots.length >= limit) truncated = true;
        }
        if (lots.length >= limit) truncated = true;
      } catch (error) {
        attempt?.failure('parser');
        throw error;
      } finally {
        await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
      if (lots.length >= limit) break;
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
