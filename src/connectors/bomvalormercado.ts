import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus, AssetType } from '../core/types.js';
import * as campos from '../core/campos.js';
import { classifySeller } from '../core/normalize.js';

/**
 * BOM VALOR MERCADO (mercado.bomvalor.com.br) — produto DIFERENTE do conector
 * `bomvalor` existente (aquele é white-label por leiloeiro individual, 690
 * lotes; este é um marketplace B2B único, clientes como Vale, Sicoob, Copa
 * Energia). Achado pelo usuário em 22/09; sourceId próprio de propósito —
 * mesma empresa, catálogo sem sobreposição conhecida com o outro conector.
 *
 * Cada página de EVENTO embute os lotes prontos em JS:
 * `window.sharedData.lotes = [...]`, um array com campo por campo (título,
 * status, valores, fotos, fechamento por lote). Não precisa de HTML parsing
 * frágil. Só cobre evento de vários lotes (`/slug-id`, um segmento de path);
 * "lote avulso" (`/categoria/subcategoria/slug-id`, vários segmentos) usa
 * outro template sem esse JS — fica de fora, é minoria na home.
 *
 * `nm_statuslote` só foi confirmado com "Em Pregão" (evento ao vivo) — a
 * página de evento ENCERRADO reidrata em HTML estático com rótulos diferentes
 * ("Não Vendido", "Condicional") e sem `sharedData.lotes`, então esses eventos
 * simplesmente não aparecem aqui. É a favor: só entra inventário vivo.
 */

const HOST = 'mercado.bomvalor.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Extrai o primeiro objeto/array balanceado que começa em `marcador`, respeitando string e escape. */
function extraiBalanceado(html: string, marcador: string, abre: '{' | '['): string | null {
  const idx = html.indexOf(marcador);
  if (idx < 0) return null;
  const fecha = abre === '{' ? '}' : ']';
  const start = idx + marcador.length;
  let nivel = 0;
  let emString = false;
  let escapado = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (emString) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === abre) nivel++;
    else if (c === fecha && --nivel === 0) return html.slice(start, i + 1);
  }
  return null;
}

function statusDe(nm: string): LotStatus {
  const t = nm.toLowerCase();
  if (/vendid|arrematad/.test(t)) return 'vendido';
  // Condicional: lance já dado, falta só aprovação do comitente — sem
  // reoferta ao público (mesmo contrato confirmado no soleon em 21/09).
  if (/condicional/.test(t)) return 'encerrado';
  if (/em preg[ãa]o|aberto/.test(t)) return 'aberto';
  return 'sem_data';
}

/** "DD/MM/YY HH:MM" ou "DD/MM/AAAA HH:MM", sempre horário de Brasília. */
function dataBr(v?: string | null): Date | null {
  const m = String(v ?? '').match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mes, aRaw, h, min] = m;
  const a = aRaw.length === 2 ? `20${aRaw}` : aRaw;
  const t = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function assetTypeDe(slug: string): AssetType {
  if (/^imoveis\//.test(slug)) return 'imovel';
  if (/^veiculos\//.test(slug)) return 'veiculo';
  return 'outro';
}

interface EventoLink {
  href: string;
  id: string;
}

/** Só evento de vários lotes: um segmento de path (`/slug-id`). Lote avulso
 * (`/categoria/sub/slug-id`) tem outro template, sem sharedData.lotes. */
async function eventos(): Promise<EventoLink[]> {
  const r = await fetchText(`https://${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
  if (r.status !== 200) return [];
  const vistos = new Map<string, string>();
  for (const m of r.body.matchAll(/ID:<b>(\d+)<\/b>/g)) {
    const antes = r.body.lastIndexOf('<a href="', m.index);
    const hrefM = /<a href="(\/[^"/][^"]*)"/.exec(r.body.slice(antes, antes + 200));
    const href = hrefM?.[1];
    if (href && !href.slice(1).includes('/') && !vistos.has(href)) vistos.set(href, m[1]);
  }
  return [...vistos.entries()].map(([href, id]) => ({ href, id }));
}

export const bomvalormercado: Connector = {
  def: {
    id: 'bomvalormercado',
    name: 'Bom Valor Mercado',
    platform: 'Bom Valor Mercado',
    method: 'html',
    tier: 3,
    siteUrl: 'https://mercado.bomvalor.com.br',
    notes: 'Marketplace B2B da Bom Valor (produto distinto do conector bomvalor). Lotes vêm prontos em window.sharedData.lotes por página de evento.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const lista = await eventos();

    for (const ev of lista) {
      if (lots.length >= limit) break;
      let r;
      try {
        r = await fetchText(`https://${HOST}${ev.href}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
      } catch {
        continue;
      }
      httpStatus = r.status;
      if (r.status !== 200) continue;

      const brutoEvento = extraiBalanceado(r.body, 'window.sharedData = ', '{');
      let leilao: any = {};
      if (brutoEvento) {
        try {
          leilao = JSON.parse(brutoEvento.replace(/^(\s*)(\w+)\s*:/gm, '$1"$2":')).leilao ?? {};
        } catch {
          leilao = {};
        }
      }
      const [cidadeEvento, ufEvento] = String(leilao.nm_local ?? '')
        .split(',')
        .map((s: string) => s.trim());

      const brutoLotes = extraiBalanceado(r.body, 'window.sharedData.lotes = ', '[');
      if (!brutoLotes) continue;
      let itens: any[];
      try {
        itens = JSON.parse(brutoLotes);
      } catch {
        continue;
      }
      if (!Array.isArray(itens) || !itens.length) continue;
      fetched += itens.length;

      for (const it of itens) {
        if (lots.length >= limit) break;
        const titulo = String(it.nm_titulo ?? '').trim();
        if (!titulo) {
          skipped++;
          continue;
        }
        const slug: string = it.nm_slug ?? '';
        const local =
          campos.localDeTexto(titulo) ??
          (cidadeEvento && ufEvento && campos.ehUf(ufEvento) ? { city: campos.apararCidade(cidadeEvento), uf: ufEvento.toUpperCase() } : null);

        lots.push({
          sourceId: 'bomvalormercado',
          externalId: String(it.lote_id ?? it.id),
          lotUrl: `https://${HOST}/${slug}`,
          titleRaw: titulo,
          assetType: assetTypeDe(slug),
          docType: leilao.nm_rede ? String(leilao.nm_rede).trim() : null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: null,
          auctionEndUtc: dataBr(it.dt_fechamento_formatado) ?? dataBr(leilao.dt_fechamento),
          sourceTz: 'America/Sao_Paulo',
          status: statusDe(String(it.nm_statuslote ?? '')),
          // Sem campo de maior lance no payload — só inicial e a contagem de
          // ofertas (que chega via outra chamada, não capturada aqui).
          minBid: campos.dinheiro(it.vl_lanceinicial),
          appraisal: campos.dinheiro(it.vl_lanceminimo),
          bidIncrement: campos.dinheiro(it.vl_incremento),
          feesPct: campos.porcentagem(it.nu_comissaoarrematantelote),
          sellerName: leilao.nm_rede ? String(leilao.nm_rede).trim() : null,
          sellerType: classifySeller(leilao.nm_rede) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: Array.isArray(it.fotos) ? it.fotos.slice(0, 30) : [],
          raw: { evento: ev.id, statuslote_id: it.statuslote_id, nu_lote: it.nu_lote },
        });
      }
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
