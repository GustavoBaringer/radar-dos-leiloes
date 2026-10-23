import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectOptions, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifyAsset, classifyProperty, classifySeller, looksLikeCollectible, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';
import { dueTenants, filterTenantPopulation } from './tenant-scheduler.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';

/**
 * Plataforma white-label SOLEON: um conector para N leiloeiros.
 * 107 domínios identificados na descoberta, 63 com lote publicado.
 *
 * As rotas globais por categoria atravessam os leilões do tenant e já vêm
 * tipadas pela própria plataforma:
 *   /lotes/veiculo?tipo=veiculo&page=N
 *   /lotes/imovel?tipo=imovel&page=N
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
const EVENTOS_MAQUINAS_POR_TENANT = 5;
const PAGINAS_EVENTO_MAQUINA = 20;
export const ROTAS_CATEGORIAS = ['/lotes/veiculo?tipo=veiculo', '/lotes/imovel?tipo=imovel', '/lotes/diversos'] as const;
const DIVERSOS_TENANTS = new Set([
  'italoleiloes.com', 'snleiloes.com.br', 'construbemleiloes.com.br',
  'sydneyleiloes.com.br', 'patiorochaleiloes.com.br',
]);
// Construbem and Hammer have verified SOLEON contracts but no discovered_sites row yet (Hammer is misclassified as casa-de-leiloes);
// the manual tenant CLI's host guard fences these explicitly reviewed hosts.
const MANUAL_TENANTS = new Set(['construbemleiloes.com.br', 'hammer.lel.br']);

const MAQUINA_TITULO = /\b(compressor(?:es)?|m[aá]quina(?:s)?|equipamento(?:s)? industriais?|gerador(?:es)?|transformador(?:es)?|caldeira(?:s)?|retroescavadeira|escavadeira|empilhadeira|colheitadeira|motoniveladora|carregadeira|betoneira|trator(?:es)?)\b/i;
const IMOVEL_SINAL = /\b(im[oó]vel|apartamento|casa|sobrado|terreno|fazenda|s[ií]tio|ch[aá]cara|sala comercial|galp[aã]o|pr[eé]dio|vaga de garagem)\b/i;
const SOLEON_PART_DESCRIPTION = /\b(?:peças?|partes?)\s+(?:de\s+)?(?:motos?|motocicletas?|veículos?|carros?)\b/i;

function parecePeca(text: string): boolean {
  return looksLikePart(text) || SOLEON_PART_DESCRIPTION.test(text);
}

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
  descricao: string;
}

interface CategoryPage {
  path: string;
  page: number;
  done: boolean;
  eventUrl?: string;
  eventPages?: string[];
}

export function lerCards($: cheerio.CheerioAPI, host: string): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  $('div.lote').each((_, el) => {
    const $c = $(el);
    const href = $c.find('a[href*="/item/"]').first().attr('href') ?? '';
    const m = href.match(/\/item\/(\d+)\/detalhes/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);

    // Layout A usa <img>; layout B esconde a foto no style do link.
    const style = $c.find('a[style*="background"]').first().attr('style') ?? '';
    const fotoRaw = $c.find('.image-lote img').attr('src') ?? style.match(/url\(['"]?([^'")]+)/)?.[1] ?? null;
    const foto = fotoRaw && !/sem-imagem-lote/i.test(fotoRaw) ? fotoRaw : null;

    // A descrição é texto operacional/jurídico em muitos tenants (inclusive
    // Bidmax); só a use quando o h5 for a categoria genérica do bem.
    const descricaoBruta = $c
      .find('div[style*="justify"]')
      .first()
      .text();
    // Judicial cards can place the actual asset after party/chassis fields.
    // Extract the last asset description before applying personal-data scrubbing.
    const descricoes = [...descricaoBruta.matchAll(/Descri[çc][ãa]o(?:\s+do\s+bem)?\s*:/gi)];
    const descricaoBem = descricoes.length > 1
      ? descricaoBruta.slice(descricoes.at(-1)!.index! + descricoes.at(-1)![0].length)
      : descricaoBruta;
    const descricao = semPartesJudiciais(descricaoBem
      .replace(/^\s*Descri[çc][ãa]o\s*:?\s*/i, '')
      .replace(/\s+/g, ' ')
      .replace(/\b(?:Placa|CPF|CNPJ|RENAVAM|Chassi|Executado|Exequente|Autor|R[eé]u)\s*:\s*.*$/i, '')
      .trim());
    const textoCard = $c.text().replace(/\s+/g, ' ').trim();
    const h5 = $c.find('h5').first().text().replace(/\s+/g, ' ').trim();
    const h5Generico = /^(?:lote[-\s\d]*|lote em leil[ãa]o(?: judicial)?|ve[ií]culo|autom[oó]vel|carro|moto|motocicleta|caminhonete|caminh[aã]o|ônibus|onibus|utilit[aá]rio|im[oó]vel(?:\s+(?:rural|urbano))?|im[oó]veis|propriedade)$/i.test(h5);
    const marcaModelo = textoCard.match(/Marca\s*\/?\s*Modelo\s*:\s*(.+?)(?=(?:Placa|Ano(?:\s*\/?\s*Modelo)?|Cor|Combust[ií]vel)\s*:|$)/i)?.[1]?.trim() ?? '';
    const titulo = (!h5Generico && h5 ? h5 : marcaModelo || descricao)
      .replace(/\bplaca\s*:?\s*[A-Z]{3}[\s-]?\d[A-Z0-9]\d{2}(?:\/[A-Z]{2})?/gi, '')
      .replace(/\b(?:chassi|renavam)\s*:?\s*[A-Z0-9]{8,30}/gi, '').slice(0, 180);
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
      descricao,
    });
  });
  return out;
}

export function judicialAssetTitle(html: string): string | null {
  const $ = cheerio.load(html); $('script,style').remove();
  const text = $.root().text().replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/Descri[çc][ãa]o(?:\s+do\s+bem)?\s*:/gi)];
  if (!matches.length) return null;
  const last = matches.at(-1)!;
  const asset = text.slice(last.index! + last[0].length)
    .split(/Localiza[çc][ãa]o:|Valor Total Penhorado:|CONTATOS/i)[0]
    .replace(/\bplaca\s*:?\s*[A-Z]{3}[\s-]?\d[A-Z0-9]\d{2}(?:\/[A-Z]{2})?/gi, '')
    .replace(/\b(?:chassi|renavam)\s*:?\s*[A-Z0-9]{8,30}/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!parseTitle(asset).brand && !IMOVEL_SINAL.test(asset) && !MAQUINA_TITULO.test(asset)) return null;
  return asset.slice(0, 180);
}

export function novosCards(cards: Card[], vistos: Set<string>): Card[] {
  return cards.filter((card) => {
    if (vistos.has(card.itemId)) return false;
    vistos.add(card.itemId);
    return true;
  });
}

export function assinaturaPagina(cards: Card[]): string {
  return cards.map((card) => card.itemId).join(',');
}

function eventosDeMaquinas(html: string, host: string): Array<{ url: string; title: string }> {
  const $ = cheerio.load(html), out = new Map<string, string>();
  $('.box-leilao').each((_, el) => {
    const card = $(el);
    const status = card.find('.label_leilao').text().replace(/\s+/g, ' ').trim();
    if (/encerrad|cancelad|suspens|finaliz|vendid/i.test(status) || !/andamento|aberto|aguard|agendad|breve/i.test(status)) return;
    const title = card.find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    if (!MAQUINA_TITULO.test(`${title} ${card.find('.card-text').text()}`)) return;
    const href = card.find('a[href*="/leilao/"][href*="/lotes"]').first().attr('href');
    if (!href) return;
    const url = new URL(href, `https://${host}`);
    if (url.hostname.replace(/^www\./, '') === host.replace(/^www\./, '') && /\/leilao\/\d+\/lotes$/.test(url.pathname)) out.set(url.href, title);
  });
  return [...out].map(([url, title]) => ({ url, title }));
}

function paginasReaisDoEvento(html: string, eventUrl: string): string[] {
  const base = new URL(eventUrl), $ = cheerio.load(html), out = new Set<string>();
  $('a[href*="page="]').each((_, el) => {
    const url = new URL($(el).attr('href') ?? '', base);
    const page = Number(url.searchParams.get('page'));
    if (url.hostname === base.hostname && url.pathname === base.pathname && Number.isInteger(page) && page > 1) out.add(url.href);
  });
  return [...out];
}

export function dataLeilaoUtc(texto: string): Date | null {
  const data = texto.match(/Leil[aã]o:\s*(\d{2})\/(\d{2})\/(\d{4})\s*[àa]s\s*(\d{1,2}):(\d{2})/i);
  if (!data) return null;
  const [dia, mes, ano, hora, minuto] = data.slice(1).map(Number);
  if (mes < 1 || mes > 12 || dia < 1 || dia > new Date(Date.UTC(ano, mes, 0)).getUTCDate() || hora > 23 || minuto > 59) return null;
  const inicio = new Date(Date.UTC(ano, mes - 1, dia, hora + 3, minuto));
  return Number.isNaN(inicio.getTime()) ? null : inicio;
}

async function tenants(limitTenants: number, tenant?: string, lookup: typeof query = query): Promise<string[]> {
  const explicitos = String(process.env.SOLEON_DOMAINS ?? '').trim();
  if (explicitos) {
    const lista = explicitos.split(',').map((d) => d.trim()).filter(Boolean);
    if (!tenant) return lista;
    const apenas = filterTenantPopulation(lista, tenant);
    if (!apenas.length) throw new Error(`single-tenant '${tenant}' fora da população explícita de SOLEON_DOMAINS`);
    return apenas;
  }
  // Modo tenant explícito: o operador pediu este domínio; coleta mesmo
  // com has_lots=false (a bandeira pode estar desatualizada). Basta
  // ser um site soleon conhecido.
  if (tenant) {
    const alvo = tenant.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
    const rows = await lookup<{ domain: string }>(
      `SELECT domain FROM discovered_sites
        WHERE platform = 'soleon'
          AND lower(regexp_replace(domain,'^www\.','')) = $1`,
      [alvo],
    );
    if (!rows.length && !MANUAL_TENANTS.has(alvo)) throw new Error(`single-tenant '${tenant}' não é site soleon conhecido`);
    return [tenant];
  }
  const rows = await lookup<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'soleon' AND http_status = 200 AND has_lots IS NOT FALSE
       ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  return dueTenants({ sourceId: 'soleon', candidates: rows.map((r) => r.domain), limit: limitTenants, track: process.env.TENANT_LEDGER_ENABLED === '1' });
}

/**
 * O leiloeiro só existe no DETALHE do lote — não está na listagem nem no card,
 * e varia por leilão dentro do mesmo tenant (rico tem 4+), então não cabe cache
 * por domínio. O que salva o custo é que o leiloeiro de um lote NUNCA muda:
 * quem já tem nome no banco não é buscado de novo, e o regime permanente fica
 * sendo só os lotes novos.
 */
async function lotesJaConhecidos(lookup: typeof query = query): Promise<Map<string, { auctioneerName: string | null; auctionStartUtc: Date | null }>> {
  const rows = await lookup<{ external_id: string; auctioneer_name: string | null; auction_start_utc: Date | null }>(
    `SELECT external_id, auctioneer_name, auction_start_utc FROM lots
      WHERE source_id = 'soleon' AND (auctioneer_name IS NOT NULL OR auction_start_utc IS NOT NULL)`,
  );
  return new Map(rows.map((r) => [r.external_id, { auctioneerName: r.auctioneer_name, auctionStartUtc: r.auction_start_utc }]));
}

async function lerDetalhe(url: string, observer?: import('../domain/collection/tenant-attempts.js').TenantAttempt, fetch: typeof fetchText = fetchText): Promise<{ leiloeiro: string | null; auctionStartUtc: Date | null; failure?: string }> {
  try {
    const r = await fetch(url, { gapMs: 1100, timeoutMs: 30000 });
    observer?.response(r.status);
    if (r.status !== 200) return { leiloeiro: null, auctionStartUtc: null, failure: `detalhe HTTP ${r.status}` };
    const $ = cheerio.load(r.body);
    const auctionStartUtc = dataLeilaoUtc($('meta[property="og:description"]').attr('content') ?? '');
    return {
      leiloeiro: campos.nomeDeLeiloeiro(/LEILOEIRO OFICIAL<\/h5>\s*([^<]+)<br>/i.exec(r.body)?.[1]),
      auctionStartUtc,
    };
  } catch {
    throwIfCancelled();
    observer?.failure('network');
    return { leiloeiro: null, auctionStartUtc: null, failure: 'falha de rede no detalhe' };
  }
}

function condicaoDo(texto: string): 'sucata' | 'conservado' | 'desconhecido' {
  if (/\bsucata\b/i.test(texto)) return 'sucata';
  if (/\bconservad[oa]s?\b/i.test(texto)) return 'conservado';
  return 'desconhecido';
}

export async function collectSoleon(
  { limit, observer, tenant }: CollectOptions,
  io: { fetchText: typeof fetchText; query: typeof query } = { fetchText, query },
): Promise<CollectResult> {
    const fetch = io.fetchText;
    const lookup = io.query;
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    const partialReasons = new Set<string>();

    const dominios = await tenants(Number(process.env.SOLEON_TENANTS ?? 12), tenant, lookup);
    const conhecidos = await lotesJaConhecidos(lookup);
    const cota = Math.max(LOTES_POR_PAGINA, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      if (lots.length >= limit) break;
      const attempt = await observer?.start(host);
      const antes = lots.length;
      const fetchedAntes = fetched, skippedAntes = skipped;
      let truncated = false;
      try {
        const normalizedHost = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
        const httpHost = normalizedHost === 'hammer.lel.br' ? 'www.hammer.lel.br' : host;
        const categorias: CategoryPage[] = (['focoleiloes.com.br', 'ccjleiloes.com.br'].includes(normalizedHost) || DIVERSOS_TENANTS.has(normalizedHost)
          ? ROTAS_CATEGORIAS
          : ROTAS_CATEGORIAS.slice(0, 2)).map((path) => ({ path, page: 1, done: false }));
        if (['ccjleiloes.com.br', 'colodeteleiloes.com.br', 'leilaopernambuco.com.br'].includes(normalizedHost)) {
          try {
            const home = await fetch(`https://${httpHost}/`, { gapMs: 1100 });
            attempt?.response(home.status);
            httpStatus = home.status;
            if (home.status === 200) {
              const $home = cheerio.load(home.body);
              const eventUrls = new Set<string>();
              $home('a[href*="/leilao/"][href*="/lotes"]').each((_, el) => {
                const href = $home(el).attr('href');
                if (!href) return;
                try {
                  const url = new URL(href, `https://${host}`);
                  if (url.hostname.replace(/^www\./, '') === normalizedHost && /^\/leilao\/\d+\/lotes$/.test(url.pathname)) eventUrls.add(url.href);
                } catch { /* ignore malformed unrelated links */ }
              });
              for (const url of eventUrls) categorias.push({ path: new URL(url).pathname, page: 1, done: false, eventUrl: url, eventPages: [url] });
              if (!eventUrls.size) partialReasons.add(`${host}: home sem eventos /leilao/{id}/lotes; catálogo incompleto`);
              else partialReasons.add(`${host}: ${eventUrls.size} eventos detectados na home; volume total desconhecido`);
            } else partialReasons.add(`${host}: home HTTP ${home.status}; eventos não descobertos`);
          } catch {
            throwIfCancelled();
            attempt?.failure('network');
            partialReasons.add(`${host}: falha de rede na home; eventos não descobertos`);
          }
        }
        const vistos = new Set<string>();
        const paginasVistas = new Map<string, Set<string>>();
        while (categorias.some((c) => !c.done) && lots.length - antes < cota && lots.length < limit) {
          throwIfCancelled();
          for (const categoria of categorias) {
            if (categoria.done || lots.length - antes >= cota || lots.length >= limit) continue;
            throwIfCancelled();
            let res;
            try {
             const eventUrl = categoria.eventUrl;
             const eventPages = categoria.eventPages;
             res = await fetch(eventUrl ? eventPages?.[categoria.page - 1] ?? eventUrl : `https://${httpHost}${categoria.path}${categoria.path.includes('?') ? '&' : '?'}page=${categoria.page}`, { gapMs: 1100 });
            } catch {
              throwIfCancelled();
              attempt?.failure('network');
              partialReasons.add(`${host} ${categoria.path}: falha de rede`);
              categoria.done = true;
              continue;
            }
            attempt?.response(res.status);
            httpStatus = res.status;
            if (res.status !== 200) { categoria.done = true; partialReasons.add(`${host} ${categoria.path}: HTTP ${res.status}`); continue; }

            const paginaCards = lerCards(cheerio.load(res.body), host);
            const sig = assinaturaPagina(paginaCards);
            const categoriasVistas = paginasVistas.get(categoria.path) ?? new Set<string>();
            if (sig && categoriasVistas.has(sig)) { categoria.done = true; continue; }
            if (sig) categoriasVistas.add(sig);
            paginasVistas.set(categoria.path, categoriasVistas);
            const cards = novosCards(paginaCards, vistos);
            fetched += cards.length;
            const eventUrl = categoria.eventUrl;
            const eventPages = categoria.eventPages;
            if (eventUrl && eventPages) {
              for (const pageUrl of paginasReaisDoEvento(res.body, eventPages[categoria.page - 1] ?? eventUrl)) if (!eventPages.includes(pageUrl)) eventPages.push(pageUrl);
              categoria.done = categoria.page >= eventPages.length;
            } else if (paginaCards.length < LOTES_POR_PAGINA) categoria.done = true;

            for (let i = 0; i < cards.length; i++) {
              throwIfCancelled();
              const c = cards[i];
              if (lots.length - antes >= cota || lots.length >= limit) { truncated = true; break; }
              if (normalizedHost === 'leilaopernambuco.com.br' && !parseTitle(c.titulo).brand && !IMOVEL_SINAL.test(c.titulo)) {
                const response = await fetch(c.url, { gapMs: 1100, timeoutMs: 30000 });
                attempt?.response(response.status);
                if (response.status === 200) c.titulo = judicialAssetTitle(response.body) ?? c.titulo;
              }
              const titulo = semPartesJudiciais(c.titulo);
              const bemTexto = `${titulo} ${c.descricao}`;
              const routeVehicle = categoria.path.includes('/lotes/veiculo');
              if (!titulo || (routeVehicle ? parecePeca(titulo) || SOLEON_PART_DESCRIPTION.test(c.descricao) : parecePeca(bemTexto)) || looksLikeCollectible(bemTexto)) { skipped++; continue; }
              const corpo = semPartesJudiciais(c.corpo);
              const parsed = parseTitle(titulo);
              const temSinalMaquina = MAQUINA_TITULO.test(titulo);
              const diverse = categoria.path === '/lotes/diversos' || Boolean(categoria.eventUrl);
              const temSinalImovel = IMOVEL_SINAL.test(titulo);
              const inferredAsset = classifyAsset(titulo);
              const vehicleIdentity = (Boolean(parsed.brand) || inferredAsset.vehicleType === 'reboque') && !looksLikePart(titulo);
              const routeProperty = categoria.path.includes('/lotes/imovel');
              if (diverse && !temSinalMaquina && !temSinalImovel && !vehicleIdentity) { skipped++; continue; }
              if (routeVehicle && !vehicleIdentity || routeProperty && !temSinalImovel) { skipped++; continue; }
              const kind = classifyAsset(titulo, temSinalMaquina ? 'maquina' : routeProperty || temSinalImovel ? 'imovel' : vehicleIdentity || routeVehicle ? 'veiculo' : null);
              if (kind.assetType === 'outro') { skipped++; continue; }
              const ehImovel = !temSinalMaquina && (routeProperty || temSinalImovel || kind.assetType === 'imovel');
              const posLocal = corpo.search(/Local de Exposi[çc][ãa]o/i);
              const janela = posLocal >= 0 ? corpo.slice(posLocal, posLocal + 200) : '';
              const CORTE_UI = /\s*(Aguarde|Aberto para|Encerrad|Lance Inicial|Maior Lance|Detalhes do Lote|Acompanhe ao Vivo)/i;
              const local = janela.replace(/^Local de Exposi[çc][ãa]o\s*:?\s*/i, '').split(/\s{2,}|Descri[çc]|Processo/)[0]?.split(CORTE_UI)[0]?.trim() || null;
              const cidadeUf = [...janela.matchAll(/([A-Za-zÀ-ú][A-Za-zÀ-ú\s.']{2,40}?)\s*[\/-]\s*([A-Z]{2})\b/g)].filter((m) => campos.ehUf(m[2])).pop();
              const km = Number(corpo.match(/\bKM\s*:?\s*([\d.]+)/i)?.[1]?.replace(/\./g, '')) || null;
              const maiorLance = /maior\s+lance/i.test(c.rotuloValor ?? '');
              const conhecido = conhecidos.get(`${host}:${c.itemId}`);
              const precisaDetalhe = !conhecido || !conhecido.auctioneerName || !conhecido.auctionStartUtc;
              const detalhe = precisaDetalhe ? await lerDetalhe(c.url, attempt, fetch) : { leiloeiro: null, auctionStartUtc: null };
              if (detalhe.failure) partialReasons.add(`${host} item/${c.itemId}: ${detalhe.failure}`);
              const leiloeiro = conhecido?.auctioneerName ?? detalhe.leiloeiro;

              lots.push({
                sourceId: 'soleon', externalId: `${host}:${c.itemId}`, lotUrl: c.url, titleRaw: titulo,
                brand: ehImovel ? null : parsed.brand, model: ehImovel ? null : parsed.model, version: ehImovel ? null : parsed.version,
                yearMake: ehImovel ? null : Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*(\d{4})/i)?.[1]) || parsed.yearMake,
                yearModel: ehImovel ? null : Number(corpo.match(/ANO\s*\/?\s*MODELO\s*:?\s*\d{4}\s*\/\s*(\d{4})/i)?.[1]) || parsed.yearModel,
                km: ehImovel ? null : km, color: ehImovel ? null : corpo.match(/\bCOR\s+([A-Za-zÀ-ú]+)/i)?.[1] ?? null,
                fuel: ehImovel ? null : corpo.match(/\b(diesel|flex|gasolina|[áa]lcool|el[ée]trico|h[íi]brido)\b/i)?.[1] ?? null,
                docType: /judicial|processo/i.test(corpo) ? 'judicial' : null,
                sourceCategory: ehImovel ? 'imovel' : vehicleIdentity || routeVehicle ? 'veiculo' : temSinalMaquina ? 'maquina' : null, assetType: ehImovel ? 'imovel' : kind.assetType,
                vehicleType: ehImovel ? null : kind.vehicleType,
                propertyType: ehImovel ? classifyProperty(titulo, 'imovel') : null,
                closingModel: 'sequencial', auctionStartUtc: conhecido?.auctionStartUtc ?? detalhe.auctionStartUtc, auctionEndUtc: null,
                sourceTz: 'America/Sao_Paulo', status: c.status,
                currentBid: maiorLance ? c.valor : null, minBid: maiorLance ? null : c.valor,
                auctioneerName: leiloeiro, sellerName: null, sellerType: classifySeller(null) as any,
                city: cidadeUf ? campos.apararCidade(cidadeUf[1].trim()) || null : null,
                state: cidadeUf?.[2] ?? null, yard: local, photos: c.foto ? [c.foto] : [],
                raw: { tenant: host, itemId: c.itemId, lote: c.lote, rotuloValor: c.rotuloValor, condition: condicaoDo(c.descricao) },
              });
            }
              if (!categoria.done && !eventUrl) categoria.page++;
              else if (!categoria.done && eventUrl) categoria.page++;
          }
        }
        if (categorias.some((c) => !c.done)) truncated = true;
        if (truncated) partialReasons.add(`${host}: limite/categoria/paginação parcial`);

        const alreadyHasMachine = lots.slice(antes).some((lot) => lot.vehicleType === 'maquina');
        if (normalizedHost === 'colodeteleiloes.com.br' && !alreadyHasMachine && lots.length < limit && lots.length - antes < cota) {
          let home;
          try {
            throwIfCancelled();
            home = await fetch(`https://${httpHost}/`, { gapMs: 1100 });
            throwIfCancelled();
          } catch (error) {
            throwIfCancelled();
            attempt?.failure('network');
          }
          if (home) {
            attempt?.response(home.status);
            httpStatus = home.status;
            if (home.status === 200) {
              const allEvents = eventosDeMaquinas(home.body, host);
              const machineEvents = allEvents.slice(0, EVENTOS_MAQUINAS_POR_TENANT);
              if (allEvents.length > machineEvents.length) truncated = true;
              for (const eventInfo of machineEvents) {
                if (lots.length >= limit || lots.length - antes >= cota) { truncated = true; break; }
                const pages = [eventInfo.url], pagesSeen = new Set<string>(), pageSigs = new Set<string>();
                while (pages.length && pagesSeen.size < PAGINAS_EVENTO_MAQUINA) {
                  throwIfCancelled();
                  const pageUrl = pages.shift()!;
                  if (pagesSeen.has(pageUrl)) continue;
                  pagesSeen.add(pageUrl);
                  let res;
                  try {
                    res = await fetch(pageUrl, { gapMs: 1100 });
                    throwIfCancelled();
                  } catch (error) {
                    throwIfCancelled();
                    attempt?.failure('network');
                    continue;
                  }
                  attempt?.response(res.status);
                  httpStatus = res.status;
                  if (res.status !== 200) continue;
                  const pageCards = lerCards(cheerio.load(res.body), host);
                  const sig = assinaturaPagina(pageCards);
                  const nextPages = paginasReaisDoEvento(res.body, pageUrl);
                  if (sig && pageSigs.has(sig)) {
                    if (nextPages.some((next) => !pagesSeen.has(next))) truncated = true;
                    break;
                  }
                  if (sig) pageSigs.add(sig);
                  for (const c of novosCards(pageCards, vistos)) {
                    throwIfCancelled();
                    if (lots.length >= limit || lots.length - antes >= cota) { truncated = true; break; }
                    fetched++;
                    const title = semPartesJudiciais(c.titulo);
                    const bemTexto = `${title} ${c.descricao}`;
                    if (!title || parecePeca(bemTexto) || looksLikeCollectible(bemTexto) || !MAQUINA_TITULO.test(bemTexto)) { skipped++; continue; }
                    const kind = classifyAsset(title, 'maquina');
                    if (kind.assetType === 'outro' || kind.vehicleType !== 'maquina') { skipped++; continue; }
                    const known = conhecidos.get(`${host}:${c.itemId}`);
                    const detail = !known || !known.auctioneerName || !known.auctionStartUtc ? await lerDetalhe(c.url, attempt, fetch) : { leiloeiro: null, auctionStartUtc: known.auctionStartUtc };
                    if (detail.failure) partialReasons.add(`${host} item/${c.itemId}: ${detail.failure}`);
                    const body = semPartesJudiciais(c.corpo);
                    const location = campos.localDeTexto(body);
                    const maiorLance = /maior\s+lance/i.test(c.rotuloValor ?? '');
                    lots.push({
                      sourceId: 'soleon', externalId: `${host}:${c.itemId}`, lotUrl: c.url, titleRaw: title,
                      sourceCategory: null, assetType: kind.assetType, vehicleType: kind.vehicleType,
                      closingModel: 'sequencial', auctionStartUtc: known?.auctionStartUtc ?? detail.auctionStartUtc, auctionEndUtc: null,
                      sourceTz: 'America/Sao_Paulo', status: c.status,
                      currentBid: maiorLance ? c.valor : null, minBid: maiorLance ? null : c.valor,
                      auctioneerName: known?.auctioneerName ?? detail.leiloeiro,
                      sellerType: classifySeller(null) as any, city: location?.city ?? null, state: location?.uf ?? null,
                      photos: c.foto ? [c.foto] : [], raw: { tenant: host, itemId: c.itemId, evento: eventInfo.title, machineSupplement: true, condition: condicaoDo(c.descricao) },
                    });
                  }
                  if (pagesSeen.size >= PAGINAS_EVENTO_MAQUINA && nextPages.length) truncated = true;
                  for (const next of nextPages) if (!pagesSeen.has(next)) pages.push(next);
                }
                if (pages.length) truncated = true;
              }
            }
          }
        }
        if (lots.length >= limit) truncated = true;
      } catch (error) {
        if (error instanceof CollectionCancellationError) attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
        else attempt?.failure('parser');
        throw error;
      } finally {
        await attempt?.finish({ fetched: fetched - fetchedAntes, skipped: skipped - skippedAntes, returned: lots.length - antes, truncated });
      }
      if (lots.length >= limit) break;
    }

    if (lots.length >= limit) partialReasons.add(`limite solicitado (${limit}) atingido; catálogo parcial`);
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus, note: partialReasons.size ? [...partialReasons].join('; ') : undefined };
}

export const soleon: Connector = {
  def: {
    id: 'soleon',
    name: 'Plataforma SOLEON',
    platform: 'SOLEON',
    method: 'html',
    tier: 2,
    siteUrl: 'https://www.soleon.com.br',
    notes: 'White-label multi-tenant. Rotas /lotes/veiculo e /lotes/imovel por tenant. 1 req/s por host; tenants vêm de discovered_sites.',
  },
  collect: collectSoleon,
};
