/**
 * Plataforma **Suporte Leilões** — white-label multi-tenant, HTML com JSON embutido.
 *
 * Duas gerações de front-end convivem no mesmo backend: v1 (Laravel, 89 dos 107
 * domínios) e v2 (Next.js/RSC, 2 domínios). Este conector implementa a **v1**,
 * onde mora o volume; a v2 fica documentada em `specs/suporte-leiloes.md` e
 * pendente — 2 tenants não justificam o parser do protocolo Flight agora.
 *
 * O dado vem do `<script>var lote = {...}</script>` da página de detalhe e dos
 * cards da busca. Não há API pública: `api-v2.suporteleiloes.com.br` responde
 * 401 mesmo com Referer e Origin do tenant.
 */
import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import { query } from '../core/db.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';
import * as campos from '../core/campos.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
/** 1 = Veículos, 2 = Imóveis. Confirmado idêntico em 6 tenants. */
const CATEGORIAS: Array<[number, AssetType]> = [[1, 'veiculo'], [2, 'imovel']];
const POR_PAGINA = 12;

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Tenants genuínos.
 *
 * `platform='suporte-leiloes'` NÃO serve como lista: o regex da descoberta usa
 * `\.leilao\.br`, que é sufixo genérico, e marcou **superbid.net** — o maior
 * player do mercado, que já tem conector próprio. Coletá-lo aqui duplicaria o
 * catálogo dele com um parser feito para outra plataforma.
 *
 * A assinatura real é o CDN compartilhado no HTML da home.
 */
const FORA = new Set(['superbid.net', 'mercadoleiloes.com.br', 'confiancaleiloes.leilao.br', 'e-leiloeiro.leilao.br', 'magalhaesleiloes.com.br']);

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'suporte-leiloes' AND http_status = 200 AND has_lots IS NOT FALSE
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC
      LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain).filter((d) => !FORA.has(d));
}

/** A assinatura que separa tenant genuíno de falso positivo da descoberta. */
function ehSuporteLeiloes(html: string): boolean {
  return /static\.suporteleiloes\.com\.br|suporteleiloes/i.test(html);
}

/**
 * Dados do LEILÃO (evento), lidos de um lote qualquer dele.
 *
 * A data não existe no card nem no lote: `dataFechamento` e `cronometro` do
 * lote vêm null em toda a amostra. Quem carrega o prazo é o evento, em
 * `leilao.data{1,2,3}` com `leilao.praca` dizendo qual vale agora.
 *
 * Sem isso, todo lote desta fonte entrava sem data nenhuma — 1.540 lotes que
 * nenhuma regra de encerramento alcançava, nem o relógio nem a verificação.
 */
interface DadosDoLeilao {
  fim: Date | null;
  leiloeiro: string | null;
  codigo: string | null;
}

/** O slug do leilão na URL do lote é a chave do evento: /eventos/leilao/{slug}/lote/{id}/... */
const slugDoLeilao = (url: string): string | null => /\/eventos\/leilao\/([^/]+)\/lote\//.exec(url)?.[1] ?? null;

function dataDoBloco(v: any): Date | null {
  // O formato é {date, timezone_type, timezone} do PHP, em America/Fortaleza —
  // mesmo UTC-3 de Brasília e sem horário de verão.
  const bruto = typeof v === 'string' ? v : v?.date;
  if (!bruto) return null;
  const t = Date.parse(`${String(bruto).replace(' ', 'T').slice(0, 19)}-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function lerLeilao(urlDeUmLote: string): Promise<DadosDoLeilao | null> {
  let r;
  try {
    r = await fetchText(urlDeUmLote, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 30000 });
  } catch {
    return null;
  }
  if (r.status !== 200) return null;
  // `var lote = {...};` — JSON válido, produzido por json_encode do PHP.
  const m = /var\s+lote\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(r.body);
  if (!m) return null;
  let lote: any;
  try {
    lote = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const le = lote?.leilao;
  if (!le) return null;
  const praca = Number(le.praca ?? 1);
  return {
    fim: dataDoBloco(le[`data${praca >= 3 ? 3 : praca === 2 ? 2 : 1}`]) ?? dataDoBloco(le.data1),
    // A fonte publica "Leiloeiro Oficial Exemplo" em leilão de teste; nome
    // falso na faceta é pior que faceta vazia.
    leiloeiro: campos.nomeDeLeiloeiro(le.leiloeiro?.nome),
    codigo: le.codigo ? String(le.codigo) : null,
  };
}

const STATUS: Record<string, LotStatus> = { '1': 'aberto' };
const statusDoCard = (classe: string): LotStatus => {
  const m = /status-(\d+)/.exec(classe);
  // Código não observado vira 'aberto' e o bruto vai para `raw`: a listagem só
  // mostra lote ativo, e chutar 'encerrado' esconderia catálogo vivo. A rotina
  // de encerramento (prazo + verificação na origem) corrige depois.
  return (m && STATUS[m[1]]) ?? 'aberto';
};

interface Card {
  id: string;
  url: string;
  titulo: string;
  categoria: string | null;
  foto: string | null;
  status: LotStatus;
  statusBruto: string | null;
  minBid: number | null;
  currentBid: number | null;
  city: string | null;
  state: string | null;
}

/**
 * Cards da listagem.
 *
 * O container `div.lote-main` carrega o id e o status nas próprias classes
 * (`bem-index-{id}` e `lote-main-status-{n}`), o que evita depender da ordem
 * dos elementos internos.
 *
 * Duas armadilhas medidas na marcação:
 *  - o `<h3>` é a CATEGORIA ("Ambulância"), não o título; o título está no
 *    primeiro `<p>` de `.reset-grid` ("FIAT / DOBLO GREENCAR MO4 2016 / 2016").
 *    Pegar "o primeiro `<p>` do card" traz um aviso comercial ("Sem Prazo Para
 *    Desvinculação"), que foi o que a primeira versão gravou como título.
 *  - "Lance Atual" vem com o texto "-" quando não há lance; sem tratar, vira 0.
 */
function lerCards(html: string, host: string): Card[] {
  const $ = cheerio.load(html);
  const cards: Card[] = [];

  $('.lote-main').each((_, el) => {
    const bloco = $(el);
    const classe = bloco.attr('class') ?? '';
    const href = bloco.find('a[href*="/lote/"]').first().attr('href') ?? '';
    const id = /bem-index-(\d+)/.exec(classe)?.[1] ?? /\/lote\/(\d+)/.exec(href)?.[1];
    if (!id || !href || cards.some((c) => c.id === id)) return;

    const grid = bloco.find('.reset-grid').first();
    const titulo = grid.find('p').first().text().replace(/\s+/g, ' ').trim();
    if (!titulo) return;

    // "Barão de Cocais - MG" — a spec dizia que não havia local no card; há.
    const local = bloco.find('.r2 span').first().text().trim();
    const mLocal = /^(.+?)\s*-\s*([A-Z]{2})$/.exec(local);

    const foto = bloco.find('img.img-evento, a.link-img img').first().attr('src') ?? null;
    const statusBruto = /lote-main-status-(\d+)/.exec(classe)?.[1] ?? null;

    cards.push({
      id,
      url: href.startsWith('http') ? href : `https://${host}${href.startsWith('/') ? '' : '/'}${href}`,
      titulo,
      categoria: grid.find('h3').first().text().trim() || null,
      foto: foto && /\/bens\//.test(foto) ? foto : null,
      status: statusDoCard(classe),
      statusBruto,
      minBid: num(bloco.find('.r4 strong.reset-colorGrid').first().text()),
      currentBid: num(bloco.find('.r4 strong.valor-grid').first().text()),
      city: mLocal ? mLocal[1].trim() : null,
      state: mLocal ? mLocal[2] : null,
    });
  });
  return cards;
}

/** Última página, pelo link de paginação. Sem o marcador, é página única. */
function ultimaPagina(html: string): number {
  const $ = cheerio.load(html);
  let max = 1;
  $('a[href*="page="]').each((_, a) => {
    const n = Number(/page=(\d+)/.exec($(a).attr('href') ?? '')?.[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

function mapCard(c: Card, asset: AssetType, host: string, ev: DadosDoLeilao | null): CanonicalLot {
  return {
    sourceId: 'suporteleiloes',
    // O id é GLOBAL nesta plataforma (medido: o mesmo id resolve para o mesmo
    // lote em tenants diferentes, e id de outro tenant dá 404 limpo, nunca um
    // lote trocado). Sem prefixo de host, ao contrário do soleon — e o overlap
    // entre tenants é resolvido de graça pela chave única.
    externalId: c.id,
    lotUrl: c.url,
    titleRaw: c.titulo,
    sourceCategory: c.categoria,
    assetType: asset,
    // A data mora no LEILÃO, não no lote: `dataFechamento` e `cronometro` do
    // lote vieram null em toda a amostra, nas duas arquiteturas.
    closingModel: 'pregao_em_horario',
    // O prazo vem do EVENTO, não do lote — ver lerLeilao().
    auctionEndUtc: ev?.fim ?? null,
    auctionStartUtc: ev?.fim ?? null,
    sourceTz: 'America/Sao_Paulo',
    status: c.status,
    auctioneerName: ev?.leiloeiro ?? null,
    currentBid: c.currentBid,
    minBid: c.minBid,
    // Metade dos lotes não traz o rótulo de local; o título e a URL trazem
    // ("Vacaria/Rio Grande do Sul: Terreno…").
    // O card às vezes traz o comitente no lugar do local ("Prefeitura
    // Municipal de Verdelandia") — o aparador tira o rótulo e sobra a cidade.
    city: campos.apararCidade(c.city ?? '') || campos.localDeTexto(c.titulo)?.city || campos.localDeTexto(c.url)?.city || null,
    state: c.state ?? campos.localDeTexto(c.titulo)?.uf ?? campos.localDeTexto(c.url)?.uf ?? null,
    photos: c.foto ? [c.foto] : [],
    photoCount: c.foto ? 1 : 0,
    raw: { tenant: host, statusCard: c.statusBruto, leilao: ev?.codigo ?? null },
  } as CanonicalLot;
}

export const suporteleiloes: Connector = {
  def: {
    id: 'suporteleiloes',
    name: 'Suporte Leilões',
    platform: 'suporte-leiloes',
    method: 'json-embedded',
    tier: 2,
    siteUrl: 'https://www.liderleiloes.com.br',
    notes:
      'White-label multi-tenant, duas gerações de front (v1 Laravel implementada, v2 Next.js pendente). A coluna platform tem falso positivo: superbid.net. Validar assinatura antes de coletar.',
  },

  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;

    const cats = CATEGORIAS.filter(([, a]) => !assetTypes || assetTypes.includes(a));
    // Cache de evento por slug, vivo durante o ciclo inteiro: o mesmo leilão
    // aparece nas duas categorias e em várias páginas.
    const eventos = new Map<string, DadosDoLeilao | null>();

    for (const host of await tenants(Number(process.env.SUPORTELEILOES_TENANTS ?? 60))) {
      if (lots.length >= limit) break;
      let assinaturaOk: boolean | null = null;

      for (const [cat, asset] of cats) {
        if (lots.length >= limit) break;
        let paginas = 1;

        for (let page = 1; page <= paginas && page <= 30; page++) {
          if (lots.length >= limit) break;
          let r;
          try {
            r = await fetchText(`https://${host}/buscador?categoria=${cat}&page=${page}`, {
              headers: { 'user-agent': UA },
              gapMs: 1100,
              timeoutMs: 30000,
            });
          } catch {
            break;
          }
          status = r.status;
          if (r.status !== 200) break;

          // A assinatura é conferida uma vez por tenant, na primeira resposta:
          // é o que impede o conector de coletar superbid.net com o parser errado.
          if (assinaturaOk === null) assinaturaOk = ehSuporteLeiloes(r.body);
          if (!assinaturaOk) break;

          if (page === 1) paginas = ultimaPagina(r.body);
          const cards = lerCards(r.body, host);
          if (!cards.length) break;
          fetched += cards.length;

          for (const c of cards) {
            if (lots.length >= limit) break;
            // UMA requisição por LEILÃO, não por lote: o prazo e o leiloeiro são
            // do evento, e o slug da URL identifica o evento. Numa página de 12
            // cards do mesmo leilão isso é 1 requisição extra, não 12.
            const slug = slugDoLeilao(c.url);
            if (slug && !eventos.has(slug)) eventos.set(slug, await lerLeilao(c.url));
            lots.push(mapCard(c, asset, host, slug ? (eventos.get(slug) ?? null) : null));
          }
          if (cards.length < POR_PAGINA) break;
        }
        if (assinaturaOk === false) break;
      }
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
