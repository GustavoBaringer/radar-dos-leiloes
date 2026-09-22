import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * SISHP — rede de 8 domínios (vinco, sfrazão, wleiloes...) que COMPARTILHA o
 * mesmo espaço de ids: `leilao.php?idLeilao=470` responde igual em qualquer
 * um dos 8 hosts (testado: sfrazao.com.br e vincoleiloes.com.br devolvem o
 * MESMO lote pro mesmo id). Por isso o dedupe é por `idLote` sozinho, não por
 * host:id como nas outras plataformas — o mesmo lote listado em dois
 * domínios do grupo não pode virar dois registros.
 *
 * O bloqueio que parecia existir (POST assíncrono com token `mid` assinado)
 * NÃO é validação real: `mid` vazio rejeita, mas `mid=x` (qualquer string
 * não-vazia) passa — e mesmo assim essa rota só devolve CONTAGEM por
 * categoria, nunca a lista. A lista de verdade é server-rendered comum,
 * achada sem POST nenhum: `leilao.php?idLeilao=N` já traz os cards com
 * título/avaliação/lance mínimo; só status e data de encerramento exigem a
 * página do lote (`lote.php?idLote=N`).
 *
 * A vitrine da home mistura evento ao vivo ("Saiba mais") com card de
 * divulgação de leilão já ENCERRADO há mais de um ano ("Divulgação",
 * exemplo medido: 2ª praça de ago/2025) — não dá para confiar nisso pra
 * filtrar. Em vez de discriminar pelo rótulo, cada id é testado na prática:
 * evento sem card de lote não entra.
 *
 * Débito conhecido: a data de encerramento vem em DOIS formatos distintos
 * ("20/10/2026 ... 10:00:00" e "23/Set/2026, 10h00") — 16 de 40 lotes
 * medidos ficaram sem data porque um terceiro formato ainda não apareceu na
 * amostra. Marca abreviada ("M.BENZ", "MPOLO") não bate no índice de
 * `parseTitle` e cai em `assetType='outro'` em vez de veículo.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EVENTOS_POR_TENANT = 6;
const LOTES_POR_EVENTO = 12;

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='sishp' AND http_status=200 ORDER BY auctioneers DESC LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function statusDe(v: string): LotStatus {
  const t = v.toLowerCase();
  if (/vendid|arrematad/.test(t)) return 'vendido';
  if (/aberto/.test(t)) return 'aberto';
  if (/agendad|em breve|aguarde/.test(t)) return 'agendado';
  if (/encerrad|cancelad|suspens|n[ãa]o vendido|deserto/.test(t)) return 'encerrado';
  return 'sem_data';
}

const MES_ABREV: Record<string, string> = {
  jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};

/** Duas formas medidas: "20/10/2026 ... 10:00:00" e "23/Set/2026, 10h00" — sempre horário de Brasília. */
function dataEncerramento(html: string): Date | null {
  const trecho = html.match(/Encerramento:[\s\S]{0,60}/)?.[0];
  if (!trecho) return null;
  const numerico = trecho.match(/(\d{2})\/(\d{2})\/(\d{4})[\s\S]{0,20}?(\d{2})[:h](\d{2})/);
  if (numerico) {
    const [, d, mes, a, h, min] = numerico;
    const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
    if (Number.isFinite(t)) return new Date(t);
  }
  const nomeado = trecho.match(/(\d{2})\/([A-Za-zç]{3})\/(\d{4})[,\s]+(\d{2})h(\d{2})/i);
  if (nomeado) {
    const [, d, mesTxt, a, h, min] = nomeado;
    const mes = MES_ABREV[mesTxt.toLowerCase()];
    if (mes) {
      const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
      if (Number.isFinite(t)) return new Date(t);
    }
  }
  return null;
}

interface CardEvento {
  id: string;
  titulo: string;
  avaliacao: number | null;
  minBid: number | null;
}

function lerCards(html: string): CardEvento[] {
  const out: CardEvento[] = [];
  // `id="cul{N}"` é o único marcador que aparece EXATAMENTE uma vez por card
  // (o link idLote= vem duplicado, mobile+desktop, fora de ordem com o resto)
  // — âncora nele e lê título/avaliação/lance à frente, nessa ordem fixa.
  const re =
    /id="cul(\d+)"[\s\S]{0,600}?lote-nome[^>]*>\s*<span[^>]*>([^<]+)<\/span>[\s\S]{0,300}?Avalia[çc][ãa]o:\s*<\/span><span>([^<]+)<\/span>[\s\S]{0,300}?Lance m[íi]nimo:\s*<\/span><span>([^<]+)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const [, id, titulo, avaliacaoTxt, lanceTxt] = m;
    out.push({ id, titulo: titulo.trim(), avaliacao: dinheiro(avaliacaoTxt), minBid: dinheiro(lanceTxt) });
  }
  return out;
}

export const sishp: Connector = {
  def: {
    id: 'sishp',
    name: 'Rede SISHP',
    platform: 'SISHP',
    method: 'html',
    tier: 3,
    siteUrl: 'https://vincoleiloes.com.br',
    notes:
      'Rede de 8 domínios com o MESMO espaço de ids (idLeilao/idLote resolve igual em qualquer host, dedupe por idLote só). Listagem sem status/data; página do lote tem os dois.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;
    const idsVistos = new Set<string>();

    const dominios = await tenants(Number(process.env.SISHP_TENANTS ?? 8));

    for (const host of dominios) {
      if (lots.length >= limit) break;
      let r;
      try {
        r = await fetchText(`https://${host}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const eventosIds = [...new Set([...r.body.matchAll(/leilao\.php\?idLeilao=(\d+)/g)].map((m) => m[1]))].slice(
        0,
        EVENTOS_POR_TENANT,
      );

      for (const idEvento of eventosIds) {
        if (lots.length >= limit) break;
        let er;
        try {
          er = await fetchText(`https://${host}/leilao.php?idLeilao=${idEvento}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
        } catch {
          continue;
        }
        if (er.status !== 200) continue;

        const cards = lerCards(er.body).slice(0, LOTES_POR_EVENTO);
        if (!cards.length) continue; // "Divulgação" velha e evento sem card caem aqui, sem diferença de custo
        fetched += cards.length;

        for (const c of cards) {
          if (lots.length >= limit) break;
          if (idsVistos.has(c.id)) continue; // mesmo lote, outro host da rede
          idsVistos.add(c.id);
          if (!c.titulo || looksLikePart(c.titulo)) {
            skipped++;
            continue;
          }

          let dr;
          try {
            dr = await fetchText(`https://${host}/lote.php?idLote=${c.id}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
          } catch {
            skipped++;
            continue;
          }
          if (dr.status !== 200) {
            skipped++;
            continue;
          }
          const statusTxt = dr.body.match(/text-uppercase font-weight-bold w-100 back-\d+">([^<]+)</)?.[1] ?? '';
          const status = statusDe(statusTxt);
          const encerramento = dataEncerramento(dr.body);
          const parsed = parseTitle(c.titulo);
          const local = campos.localDeTexto(c.titulo);

          lots.push({
            sourceId: 'sishp',
            externalId: c.id,
            lotUrl: `https://${host}/lote.php?idLote=${c.id}`,
            titleRaw: c.titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            assetType: /im[óo]vel|apartamento|casa|sobrado|terreno|sala\s+comercial|vaga\s+de\s+garagem|galp[ãa]o/i.test(c.titulo)
              ? 'imovel'
              : parsed.brand || /trator|caminh[ãa]o|[oô]nibus|micro-?[oô]nibus|retroescavadeira|carreta|ambul[âa]ncia/i.test(c.titulo)
                ? 'veiculo'
                : 'outro',
            closingModel: 'timer_por_lote',
            auctionStartUtc: null,
            auctionEndUtc: encerramento,
            sourceTz: 'America/Sao_Paulo',
            status,
            minBid: c.minBid,
            appraisal: c.avaliacao,
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: [],
            raw: { tenant: host, evento: idEvento, statusTexto: statusTxt },
          });
        }
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
