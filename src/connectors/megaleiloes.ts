import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus, AssetType } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * Plataforma compartilhada por Mega Leilões e Grupo Lance — dois leiloeiros
 * DIFERENTES rodando o mesmo software (Yii): mesmos `data-key`, `card-title`,
 * `card-price`, `card-locality`, `card-status`, mesma paginação `?pagina=N` e
 * o mesmo rodapé "Exibindo X de Y itens". Medido em 22/09: 841 imóveis no
 * mega, 363 no grupolance — de longe o maior volume entre os leiloeiros de
 * domínio próprio dos 67 mapeados.
 *
 * Dois `source_id` separados de propósito (não é white-label de um mesmo
 * dono, são empresas distintas), mas um parser só: o template diverge em
 * detalhe, não em estrutura.
 *
 * A data de praça é o único ponto onde os dois divergem de verdade — mega usa
 * `card-first-instance-date`/`card-second-instance-date`, grupolance usa uma
 * `<ol class="card-instance-date">` com início, fim e valor. Por isso a data
 * sai da ÚLTIMA ocorrência de `dd/mm/aaaa às hh:mm` do bloco, que nos dois
 * casos é o fim da última praça.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/encerrad|cancelad|suspens|finalizad/.test(t)) return 'encerrado';
  if (/aberto|fa[çc]a seu lance|em leil[ãa]o|receb/.test(t)) return 'aberto';
  if (/em breve|agendad|aguard/.test(t)) return 'agendado';
  return 'sem_data';
}

/** "23/09/2026 às 10:00" — horário de Brasília. */
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s*(?:às\s*)?(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function fotoDe(corte: string): string | null {
  const bg = corte.match(/data-bg="([^"]+)"/)?.[1]
    ?? corte.match(/background:\s*url\((\/\/[^)]+|https?:\/\/[^)]+)\)/)?.[1];
  if (!bg) return null;
  return bg.startsWith('//') ? `https:${bg}` : bg;
}

function tipoDeBem(url: string, titulo: string): AssetType {
  if (/\/imoveis\//i.test(url) || /apartamento|casa|terreno|im[óo]vel|sobrado|gleba|chac|s[íi]tio|fazenda|sala|loja|galp/i.test(titulo)) {
    return 'imovel';
  }
  if (/\/veiculos\//i.test(url)) return 'veiculo';
  return 'outro';
}

interface Card {
  id: string;
  url: string;
  titulo: string;
  preco: number | null;
  cidade: string | null;
  uf: string | null;
  status: string;
  modalidade: string | null;
  encerramento: Date | null;
  foto: string | null;
}

function lerCards(html: string, baseUrl: string): Card[] {
  const out: Card[] = [];
  for (const bloco of html.split('data-key="').slice(1)) {
    const id = bloco.match(/^(\d+)"/)?.[1];
    if (!id) continue;
    const corte = bloco.slice(0, 6000);
    const tituloM = corte.match(/class="card-title"[^>]*href="([^"]+)"[^>]*>([^<]+)</) ??
      corte.match(/class="card-title"[^>]*>([^<]+)</);
    if (!tituloM) continue;
    const temHref = tituloM.length > 2;
    const href = temHref ? tituloM[1] : '';
    const titulo = (temHref ? tituloM[2] : tituloM[1]).replace(/\s+/g, ' ').trim();
    const localM = corte.match(/class="card-locality"[^>]*title="([^"]*)"/);
    const [cidade, uf] = (localM?.[1] ?? '').split(',').map((s) => s.trim());
    // Última data do bloco = fim da última praça, nos dois templates.
    const datas = [...corte.matchAll(/(\d{2}\/\d{2}\/\d{4}\s*(?:às\s*)?\d{2}:\d{2})/g)].map((m) => m[1]);

    out.push({
      id,
      url: href.startsWith('http') ? href.split('?')[0] : `${baseUrl}${href.split('?')[0]}`,
      titulo,
      preco: dinheiro(corte.match(/class="card-price"[^>]*>\s*([^<]+)</)?.[1]),
      cidade: cidade || null,
      uf: uf && campos.ehUf(uf) ? uf.toUpperCase() : null,
      status: corte.match(/class="card-status[^"]*"[^>]*>\s*([^<]+)</)?.[1]?.trim() ?? '',
      modalidade: corte.match(/class="card-instance-title"[^>]*>\s*<a[^>]*>([^<]+)</)?.[1]?.trim() ??
        corte.match(/href="\/leiloes\/(judiciais|extrajudiciais)"[^>]*>([^<]+)</)?.[2]?.trim() ??
        null,
      encerramento: dataBr(datas[datas.length - 1]),
      // Mega usa `data-bg`, grupolance usa `background: url(...)` inline — mesmo
      // software, dois jeitos de lazy-load.
      foto: fotoDe(corte),
    });
  }
  return out;
}

/** Monta um conector pra um host desta plataforma — o parser é o mesmo. */
function conectorDaPlataforma(cfg: {
  id: string;
  nome: string;
  host: string;
  caminhos: string[];
  tier: number;
}): Connector {
  return {
    def: {
      id: cfg.id,
      name: cfg.nome,
      platform: 'Mega/Lance (Yii)',
      method: 'html',
      tier: cfg.tier,
      siteUrl: `https://${cfg.host}`,
      notes: `Listagem paginada em ${cfg.caminhos.join(', ')} com ?pagina=N; card traz título, preço, cidade/UF, status e datas de praça.`,
    },
    async collect({ limit }): Promise<CollectResult> {
      const lots: CanonicalLot[] = [];
      const vistos = new Set<string>();
      let fetched = 0;
      let skipped = 0;
      let httpStatus = 0;
      const baseUrl = `https://${cfg.host}`;

      for (const caminho of cfg.caminhos) {
        for (let pagina = 1; lots.length < limit; pagina++) {
          // Passada a última página real, o site não devolve vazio: repete um
          // bloco fixo de "recomendados" pra sempre (34 cards em /veiculos,
          // sempre ≥20) — travou 7h em produção antes desta checagem.
          const antesDaPagina = lots.length;
          let r;
          try {
            r = await fetchText(`${baseUrl}${caminho}?pagina=${pagina}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
          } catch {
            break;
          }
          httpStatus = r.status;
          if (r.status !== 200) break;

          const cards = lerCards(r.body, baseUrl);
          if (!cards.length) break;
          fetched += cards.length;

          for (const c of cards) {
            if (lots.length >= limit) break;
            if (vistos.has(c.id)) continue;
            vistos.add(c.id);
            if (!c.titulo || looksLikePart(c.titulo)) {
              skipped++;
              continue;
            }
            const assetType = tipoDeBem(c.url, c.titulo);
            const parsed = assetType === 'veiculo' ? parseTitle(c.titulo) : null;
            const local = c.cidade && c.uf ? { city: campos.apararCidade(c.cidade), uf: c.uf } : campos.localDeTexto(c.titulo);

            lots.push({
              sourceId: cfg.id,
              externalId: c.id,
              lotUrl: c.url,
              titleRaw: c.titulo,
              brand: parsed?.brand ?? null,
              model: parsed?.model ?? null,
              version: parsed?.version ?? null,
              yearMake: parsed?.yearMake ?? null,
              yearModel: parsed?.yearModel ?? null,
              assetType,
              docType: c.modalidade ? c.modalidade.toLowerCase() : null,
              closingModel: 'timer_por_lote',
              auctionStartUtc: null,
              auctionEndUtc: c.encerramento,
              sourceTz: 'America/Sao_Paulo',
              status: statusDe(c.status),
              // O `card-price` é o valor da praça VIGENTE — não dá pra saber,
              // só da listagem, se já houve lance. Fica como mínimo.
              minBid: c.preco,
              sellerType: classifySeller(null) as any,
              city: local?.city ?? null,
              state: local?.uf ?? null,
              photos: c.foto ? [c.foto] : [],
              raw: { statusTexto: c.status, modalidade: c.modalidade },
            });
          }
          // Última página: o total vem no rodapé ("Exibindo 1-48 de 841 itens").
          if (cards.length < 20) break;
          // Página cheia mas nenhum id novo: é o bloco de recomendados se
          // repetindo, não catálogo. O `dedupe` por si só nunca para o loop.
          if (lots.length === antesDaPagina) break;
        }
        if (lots.length >= limit) break;
      }
      return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
    },
  };
}

export const megaleiloes = conectorDaPlataforma({
  id: 'megaleiloes',
  nome: 'Mega Leilões',
  host: 'www.megaleiloes.com.br',
  caminhos: ['/imoveis', '/veiculos'],
  tier: 2,
});

export const grupolance = conectorDaPlataforma({
  id: 'grupolance',
  nome: 'Grupo Lance',
  host: 'www.grupolance.com.br',
  caminhos: ['/imoveis', '/veiculos'],
  tier: 3,
});
