import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';

/**
 * PORTAL ZUK (zukerman.com.br redireciona pra cá) — 884 oportunidades
 * medidas em 22/09. Listagem é server-rendered: `curl` puro já traz os cards.
 *
 * A paginação da listagem é "carregar mais" por POST com CSRF de sessão —
 * não vale reversar. O que substitui: a própria página publica links de
 * COMITENTE (`/v/{banco}`) e de CIDADE (`/c/todos-imoveis/{uf}/regiao/{cidade}`),
 * e cada um desses devolve até 30 cards completos numa requisição simples.
 * Varrer esses links cobre muito mais que os 30 da raiz, sem tocar em JS.
 *
 * Preço vem em DUAS praças no mesmo card ("1º leilão" / "2º leilão", e o Zuk
 * chama de "leilão", não de "praça"). O mínimo real é o da ÚLTIMA praça — a
 * primeira aparece riscada (`text-decoration:line-through`) quando já passou.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST = 'https://www.portalzuk.com.br';
const LISTAS_EXTRA = 24;

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s*(?:às\s*)?(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, a, h, min] = m;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

const PROP: Array<[RegExp, NonNullable<CanonicalLot['propertyType']>]> = [
  [/apartamento/i, 'apartamento'],
  [/casa|sobrado/i, 'casa'],
  [/terreno|lote|gleba/i, 'terreno'],
  [/comercial|industrial|sala|loja|galp/i, 'comercial'],
  [/rural|s[íi]tio|ch[áa]cara|fazenda/i, 'rural'],
  [/vaga|garagem/i, 'vaga'],
];

interface Card {
  id: string;
  url: string;
  tipo: string;
  endereco: string;
  cidade: string | null;
  uf: string | null;
  bairro: string | null;
  praca1: { valor: number | null; data: Date | null };
  praca2: { valor: number | null; data: Date | null };
  encerrado: boolean;
}

function lerCards(html: string): Card[] {
  const out: Card[] = [];
  for (const bloco of html.split('class="card-property card_lotes_div"').slice(1)) {
    const corte = bloco.slice(0, 5000);
    const href = corte.match(/href="(https:\/\/www\.portalzuk\.com\.br\/imovel\/[^"]+)"/)?.[1];
    const id = href?.match(/\/(\d+-\d+)$/)?.[1];
    if (!href || !id) continue;

    const localA = corte.match(/class="card-property-address"[\s\S]{0,400}?>([^<]+\/[^<]+)<\/a>\s*([^<]*)</);
    const [cidade, uf] = (localA?.[1] ?? '').split('/').map((s) => s.trim());
    const bairro = localA?.[2]?.replace(/^\s*-\s*/, '').trim() || null;
    const endereco = corte.match(/flex-basis: 100%[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

    const precos = [...corte.matchAll(/card-property-price-label"[^>]*>([^<]+)<[\s\S]{0,400}?card-property-price-value"[^>]*>([\s\S]{0,120}?)<\/span>[\s\S]{0,200}?card-property-price-data"[^>]*>([^<]+)</g)];
    const praca = (i: number) => ({
      valor: dinheiro(precos[i]?.[2]?.replace(/<[^>]+>/g, '')),
      data: dataBr(precos[i]?.[3]),
    });

    out.push({
      id,
      url: href,
      tipo: corte.match(/card-property-price-lote"[^>]*>([^<]+)</)?.[1]?.trim() ?? '',
      endereco,
      cidade: cidade || null,
      uf: uf && campos.ehUf(uf) ? uf.toUpperCase() : null,
      bairro,
      praca1: praca(0),
      praca2: praca(1),
      encerrado: /card-property-encerrado/.test(corte.slice(0, 1500)),
    });
  }
  return out;
}

export const portalzuk: Connector = {
  def: {
    id: 'portalzuk',
    name: 'Portal Zuk',
    platform: 'Zuk (Laravel)',
    method: 'html',
    tier: 2,
    siteUrl: HOST,
    notes: 'Listagem server-rendered; paginação real é POST com CSRF, contornada varrendo os links de comitente (/v/) e de cidade (/c/) que a própria página publica.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    const vistos = new Set<string>();
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    let raiz;
    try {
      raiz = await fetchText(`${HOST}/leilao-de-imoveis`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    } catch {
      return { lots, fetched, skipped, httpStatus: 0 };
    }
    httpStatus = raiz.status;
    if (raiz.status !== 200) return { lots, fetched, skipped, httpStatus };

    const extras = [
      ...new Set([
        ...[...raiz.body.matchAll(/href="(https:\/\/www\.portalzuk\.com\.br\/leilao-de-imoveis\/v\/[^"]+)"/g)].map((m) => m[1]),
        ...[...raiz.body.matchAll(/href='(https:\/\/www\.portalzuk\.com\.br\/leilao-de-imoveis\/c\/[^']+)'/g)].map((m) => m[1]),
      ]),
    ].slice(0, LISTAS_EXTRA);

    for (const [i, pagina] of [raiz.body, ...extras].entries()) {
      if (lots.length >= limit) break;
      let corpo = typeof pagina === 'string' && i === 0 ? pagina : null;
      if (corpo === null) {
        try {
          const r = await fetchText(pagina as string, { headers: { 'user-agent': UA }, gapMs: 1100 });
          httpStatus = r.status;
          if (r.status !== 200) continue;
          corpo = r.body;
        } catch {
          continue;
        }
      }

      const cards = lerCards(corpo);
      fetched += cards.length;
      for (const c of cards) {
        if (lots.length >= limit) break;
        if (vistos.has(c.id)) continue;
        vistos.add(c.id);
        const titulo = [c.tipo, c.bairro, c.cidade && c.uf ? `${c.cidade}/${c.uf}` : null].filter(Boolean).join(' - ') || c.endereco;
        if (!titulo) {
          skipped++;
          continue;
        }
        // O valor que vale é o da última praça publicada; a primeira já pode
        // ter passado (o card risca o valor quando isso acontece).
        const vigente = c.praca2.valor ? c.praca2 : c.praca1;

        lots.push({
          sourceId: 'portalzuk',
          externalId: c.id,
          lotUrl: c.url,
          titleRaw: titulo,
          assetType: 'imovel',
          propertyType: PROP.find(([re]) => re.test(c.tipo))?.[1] ?? 'outro',
          sourceCategory: c.tipo || null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: c.praca1.data,
          auctionEndUtc: vigente.data,
          sourceTz: 'America/Sao_Paulo',
          status: c.encerrado ? 'encerrado' : 'aberto',
          minBid: vigente.valor,
          appraisal: c.praca1.valor,
          sellerType: classifySeller(null) as any,
          city: c.cidade ? campos.apararCidade(c.cidade) : null,
          state: c.uf,
          yard: c.endereco || null,
          photos: [],
          raw: { bairro: c.bairro, praca1: c.praca1.valor, praca2: c.praca2.valor },
        });
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
