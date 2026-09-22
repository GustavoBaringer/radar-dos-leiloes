import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

/**
 * LABASOFT — plataforma compartilhada por 3 leiloeiros: schulmannleiloes.com.br
 * (~92 lotes reais), karlapepe.lel.br e leiloesbraga.lel.br (essa última é uma
 * instância de demonstração não configurada — "Labasoft testando aaaaaaaaaaaa"
 * — mas custa zero deixá-la na lista).
 *
 * O card (`<article id="featured-post...">`) varia de marcação entre os 3
 * domínios (classe, presença de `:` no rótulo da data, `R$` no valor ou não),
 * mas o TEXTO depois de tags removidas é estável — por isso o parser lê o
 * bloco de datas como texto puro, não regex sobre HTML cru.
 *
 * Não existe rótulo de status "aberto/encerrado" — só as duas datas de praça
 * (`1º data` / `2º data`, às vezes riscadas com `<strike>` quando já
 * passaram). O relógio (`VENCIDO`) fecha pelo fim da praça mais recente;
 * aqui não se adivinha status por palavra nenhuma.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function textoLimpo(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&ordm;|&ordf;/g, 'º')
    .replace(/&agrave;/g, 'à')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Praca {
  data: Date | null;
  valor: number | null;
}

/** Duas ocorrências de "Nº data ... DD/MM/AAAA HH:MM ... valor" no texto puro. */
function lePracas(textoDatas: string): [Praca, Praca] {
  const pracas: Praca[] = [];
  const re = /\d[ºª°]?\s*data:?\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})(?:\s*à\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})?\s*(?:R\$)?\s*([\d.,]+)?/gi;
  for (const m of textoDatas.matchAll(re)) {
    pracas.push({ data: dataBr(m[1]), valor: dinheiro(m[2]) });
  }
  return [pracas[0] ?? { data: null, valor: null }, pracas[1] ?? { data: null, valor: null }];
}

function lerCards(html: string, baseUrl: string): Array<{
  id: string;
  titulo: string;
  categoria: string;
  foto: string | null;
  praca1: Praca;
  praca2: Praca;
}> {
  const out: ReturnType<typeof lerCards> = [];
  for (const bloco of html.split('id="featured-post').slice(1)) {
    const corte = bloco.slice(0, 3000);
    const id = corte.match(/detalhe\.php\?id=(\d+)/)?.[1];
    if (!id) continue;
    const tituloM = corte.match(/entry-title"[^>]*>\s*([^<]+?)\s*</);
    const titulo = tituloM?.[1]?.trim() || corte.match(/alt="([^"]*)"/)?.[1]?.trim() || '';
    const categoria = textoLimpo(corte.match(/labasoft_faixa2[\s\S]{0,150}?<\/div>/)?.[0] ?? '');
    const fotoRel = corte.match(/src="([^"]+\.(?:jpg|jpeg|png|gif))"/i)?.[1] ?? null;
    const foto = fotoRel && !/foto-indisponivel/i.test(fotoRel) ? (fotoRel.startsWith('http') ? fotoRel : `${baseUrl}${fotoRel.startsWith('/') ? '' : '/'}${fotoRel}`) : null;
    const blocoDatas = corte.match(/entry-content"[\s\S]{0,700}?<\/div>/)?.[0] ?? '';
    const [praca1, praca2] = lePracas(textoLimpo(blocoDatas));
    out.push({ id, titulo, categoria, foto, praca1, praca2 });
  }
  return out;
}

function conectorLabasoft(cfg: { id: string; nome: string; host: string; tier: number }): Connector {
  return {
    def: {
      id: cfg.id,
      name: cfg.nome,
      platform: 'Labasoft',
      method: 'html',
      tier: cfg.tier,
      siteUrl: `https://${cfg.host}`,
      notes: 'Home lista todos os lotes num template só (labasoft), sem paginação nem rótulo de status — só as duas datas de praça.',
    },
    async collect({ limit }): Promise<CollectResult> {
      const lots: CanonicalLot[] = [];
      let fetched = 0;
      let skipped = 0;
      let httpStatus = 0;
      const baseUrl = `https://${cfg.host}`;

      let r;
      try {
        r = await fetchText(`${baseUrl}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        return { lots, fetched, skipped, httpStatus: 0 };
      }
      httpStatus = r.status;
      if (r.status !== 200) return { lots, fetched, skipped, httpStatus };

      const cards = lerCards(r.body, baseUrl);
      fetched = cards.length;

      for (const c of cards) {
        if (lots.length >= limit) break;
        if (!c.titulo || looksLikePart(c.titulo)) {
          skipped++;
          continue;
        }
        const parsed = parseTitle(c.titulo);
        const local = campos.localDeTexto(c.titulo);
        // A praça mais recente com valor é a que vale — a 2ª quando existe,
        // senão a 1ª.
        const vigente = c.praca2.valor ? c.praca2 : c.praca1;

        lots.push({
          sourceId: cfg.id,
          externalId: c.id,
          lotUrl: `${baseUrl}/detalhe.php?id=${c.id}`,
          titleRaw: c.titulo,
          brand: parsed.brand,
          model: parsed.model,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          assetType: /im[óo]vel|apartamento|casa|terreno|sala|galp|pr[ée]dio|loja/i.test(c.titulo)
            ? 'imovel'
            : parsed.brand
              ? 'veiculo'
              : 'outro',
          docType: /judicial/i.test(c.categoria) ? 'judicial' : /extrajudicial/i.test(c.categoria) ? 'extrajudicial' : null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: c.praca1.data,
          auctionEndUtc: c.praca2.data ?? c.praca1.data,
          sourceTz: 'America/Sao_Paulo',
          // Sem rótulo de status na fonte — o relógio (VENCIDO) decide.
          status: 'aberto',
          minBid: vigente.valor,
          appraisal: c.praca1.valor,
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: c.foto ? [c.foto] : [],
          raw: { categoria: c.categoria, praca1: c.praca1.valor, praca2: c.praca2.valor },
        });
      }
      return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
    },
  };
}

export const schulmann = conectorLabasoft({ id: 'schulmann', nome: 'Schulmann Leilões', host: 'schulmannleiloes.com.br', tier: 3 });
export const karlapepe = conectorLabasoft({ id: 'karlapepe', nome: 'Karla Pepe Leilões', host: 'karlapepe.lel.br', tier: 4 });
export const leiloesbraga = conectorLabasoft({ id: 'leiloesbraga', nome: 'Fernando Braga Leilões', host: 'leiloesbraga.lel.br', tier: 4 });
