import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * LEILOVIA — plataforma white-label ASP.NET, achada em 22/09 a partir de 3
 * leiloeiros oficiais sem conector. Domínio curado, não via `discovered_sites`:
 * a sonda genérica nunca reconheceu essa plataforma (regex por palavra-chave
 * não bate — a home dos 3 é só institucional, o catálogo fica em `/leiloes.aspx`).
 *
 * `rpleiloes.com.br` entra na lista mesmo com 0 lote hoje (só tem 1 leilão-
 * simulador de teste): é a mesma plataforma, e ligar depois que tiver
 * inventário real custa zero — o parser já serve.
 *
 * O card da listagem já tem TUDO — título, categoria, cidade, status, preço —
 * sem precisar da página de detalhe. Preço vem em DOIS `<span>` no mesmo
 * bloco ("Lance atual" e "Lance inicial"), um deles `style="display: none"`;
 * só o `display: block` é o valor real mostrado ao usuário.
 *
 * Data de encerramento é do LEILÃO, não do lote — leilão judicial fecha em
 * sequência, e a página não expõe hora por lote na listagem (só no detalhe,
 * que custaria 1 requisição a mais por lote). "Encerramento previsto" vale
 * pra todos os lotes daquele leilão.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DOMINIOS = ['vialeiloes.com.br', 'reginaaudeleiloes.com.br', 'rpleiloes.com.br'];
const EVENTOS_POR_TENANT = 8;

function statusDe(v: string): LotStatus {
  if (/em andamento|em leil[ãa]o/i.test(v)) return 'aberto';
  if (/loteament/i.test(v)) return 'agendado';
  // "SUSPENSO POR ORDEM JUDICIAL" / "A RESTITUIR POR DETERMINAÇÃO JUDICIAL":
  // não recebe lance agora, mas nada garante que não volta — mesmo cuidado
  // do "sem_licitante" do soleon. Fica sem_data; o relógio fecha quando
  // `auctionEndUtc` passar, sem precisar adivinhar o desfecho judicial.
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * "24/09/2026 16:05", sempre horário de Brasília (a página mesma diz isso).
 *
 * Leilão sem data marcada ainda devolve "31/10/2035" — sentinela do sistema,
 * não previsão real (medido: mesmo valor em "Encerra a partir de" E
 * "Encerramento previsto" do mesmo leilão, enquanto outro leilão real tinha
 * data plausível dias à frente). Mais de 1 ano no futuro é descartado.
 */
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  if (!Number.isFinite(t)) return null;
  return t < Date.now() + 365 * 24 * 3_600_000 ? new Date(t) : null;
}

interface Card {
  id: string;
  url: string;
  categoria: string;
  titulo: string;
  cidade: string | null;
  uf: string | null;
  status: string;
  foto: string | null;
  valor: number | null;
  rotuloValor: string;
}

function lerCards(html: string, baseUrl: string): Card[] {
  const out: Card[] = [];
  const blocos = html.split('class="lote-lista"').slice(1);
  for (const bloco of blocos) {
    const href = /href='([^']+)'/.exec(bloco)?.[1] ?? /href="([^"]+)"/.exec(bloco)?.[1];
    const id = href?.match(/\/(\d+)$/)?.[1];
    if (!href || !id) continue;
    const foto = bloco.match(/data-src='([^']+)'/)?.[1] ?? null;
    const categoria = bloco.match(/class="col-md-6">\s*([^<]+?)<br/)?.[1]?.trim() ?? '';
    const titulo = bloco.match(/<blockquote>([^<]+)<\/blockquote>/)?.[1]?.trim() ?? '';
    const localTxt = bloco.match(/cidade de\s*<b>([^<]+)<\/b>/)?.[1]?.trim() ?? '';
    const [, cidade, uf] = localTxt.match(/^(.+?)\s*\(([A-Z]{2})\)$/) ?? [null, localTxt || null, null];
    const status = bloco.match(/circulo-item-grande circulo-\w+'>([^<]+)</)?.[1]?.replace(/&nbsp;/g, '').trim() ?? '';
    // As duas variantes (atual/inicial) vêm juntas; só a `display: block` é a
    // que o site mostra de verdade.
    const precoM = bloco.match(/style="display:\s*block"\s*>\s*(Lance \w+):\s*R\$\s*([\d.,]+)/);
    out.push({
      id,
      url: href.startsWith('http') ? href : `${baseUrl}${href}`,
      categoria,
      titulo,
      cidade,
      uf,
      status,
      foto: foto && foto.startsWith('http') ? foto : foto ? `${baseUrl}${foto}` : null,
      valor: dinheiro(precoM?.[2]),
      rotuloValor: precoM?.[1] ?? '',
    });
  }
  return out;
}

export const leilovia: Connector = {
  def: {
    id: 'leilovia',
    name: 'Plataforma Leilovia',
    platform: 'Leilovia',
    method: 'html',
    tier: 3,
    siteUrl: 'https://www.leilovia.com.br',
    notes: 'White-label ASP.NET, 3 domínios curados (não vem de discovered_sites — sonda genérica não reconhece). Data de encerramento é do leilão, não do lote.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    for (const host of DOMINIOS) {
      if (lots.length >= limit) break;
      const baseUrl = `https://${host}`;
      let r;
      try {
        r = await fetchText(`${baseUrl}/leiloes.aspx`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const eventos = [...new Set([...r.body.matchAll(/href='(\/leilao\/[^']+\/\d+)'/g)].map((m) => m[1]))].slice(
        0,
        EVENTOS_POR_TENANT,
      );

      for (const caminho of eventos) {
        if (lots.length >= limit) break;
        let er;
        try {
          er = await fetchText(`${baseUrl}${caminho}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        } catch {
          continue;
        }
        if (er.status !== 200) continue;

        const encerramento = dataBr(er.body.match(/Encerramento previsto:[\s\S]{0,150}?(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/)?.[1]);
        const cards = lerCards(er.body, baseUrl);
        if (!cards.length) continue;
        fetched += cards.length;

        for (const c of cards) {
          if (lots.length >= limit) break;
          if (!c.titulo || looksLikePart(c.titulo)) {
            skipped++;
            continue;
          }
          const parsed = parseTitle(c.titulo);
          const local = c.cidade ? { city: campos.apararCidade(c.cidade), uf: c.uf } : campos.localDeTexto(c.titulo);
          const atual = /atual/i.test(c.rotuloValor);

          lots.push({
            sourceId: 'leilovia',
            externalId: `${host}:${c.id}`,
            lotUrl: c.url,
            titleRaw: c.titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            sourceCategory: c.categoria || null,
            assetType: /im[óo]vel/i.test(c.categoria)
              ? 'imovel'
              : /ve[íi]culo|motocicleta|moto\b|caminh[ãa]o|[oô]nibus/i.test(c.categoria)
                ? 'veiculo'
                : 'outro',
            docType: 'judicial',
            closingModel: 'timer_por_lote',
            auctionStartUtc: null,
            auctionEndUtc: encerramento,
            sourceTz: 'America/Sao_Paulo',
            status: statusDe(c.status),
            currentBid: atual ? c.valor : null,
            minBid: atual ? null : c.valor,
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: c.foto ? [c.foto] : [],
            raw: { tenant: host, statusTexto: c.status },
          });
        }
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
