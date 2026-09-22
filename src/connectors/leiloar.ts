import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * LEILOAR — plataforma white-label (CakePHP), N leiloeiros por 1 conector.
 * MEDIDO em 22/09: 20 domínios descobertos, 14 responderam lote na sonda.
 *
 * Dois formatos de instalação no mesmo software: alguns tenants publicam na
 * raiz (`/bens/pesquisaAvancada`), outros num subdiretório (`/externo/...`) —
 * detectado por tentativa e cacheado por host.
 *
 * A busca é POST form-urlencoded com `data[Bem][termo]=` vazio; sem o
 * Content-Type certo o servidor devolve 0 resultados mesmo tendo lote (medido
 * contra adringleiloes). Paginação é segmento de path (`/pesquisaAvancada/page:N`),
 * não query string.
 *
 * Débito conhecido: o título no card vem TRUNCADO (a fonte corta e não expõe o
 * texto inteiro fora da página de detalhe) — marca/modelo/ano falha em títulos
 * longos. Buscar o detalhe de cada lote dobraria o tráfego; fica para quando o
 * volume justificar.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const POR_PAGINA = 10;

async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='leiloar' AND http_status=200 AND has_lots IS NOT FALSE
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC LIMIT $1`,
    [limite],
  );
  return rows.map((r) => r.domain);
}

const baseConhecida = new Map<string, string>();
/**
 * Tenta raiz, cai pro subdiretório /externo — cacheado por host pro resto da
 * coleta. Aceita por STATUS, não por achar "Exibindo": tenant sem lote no
 * momento devolve 200 sem esse texto, e exigir o texto fazia cair sempre pro
 * `''` padrão mesmo quando a raiz dava 404 e o /externo respondia certo —
 * 12 dos 20 tenants ficavam de fora por isso (medido em 22/09).
 */
async function base(host: string): Promise<string> {
  const conhecida = baseConhecida.get(host);
  if (conhecida != null) return conhecida;
  for (const b of ['', '/externo']) {
    try {
      const r = await fetchText(`https://${host}${b}/bens/pesquisaAvancada`, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data[Bem][termo]=',
        gapMs: 1100,
      });
      if (r.status === 200) {
        baseConhecida.set(host, b);
        return b;
      }
    } catch {
      /* tenta o próximo formato */
    }
  }
  baseConhecida.set(host, '');
  return '';
}

function statusDe(badges: string[]): LotStatus {
  const t = badges.join(' ').toUpperCase();
  if (/VENDID|ARREMATAD|COMPREI/.test(t)) return 'vendido';
  if (/ENCERRAD|CANCELAD|SUSPENS/.test(t)) return 'encerrado';
  if (/ABERTO/.test(t)) return 'aberto';
  return 'sem_data';
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

interface Card {
  id: string;
  url: string;
  titulo: string;
  foto: string | null;
  badges: string[];
  avaliacao: number | null;
  lance: number | null;
  rotuloLance: string | null;
  cidade: string | null;
  uf: string | null;
}

function lerCards($: cheerio.CheerioAPI, baseUrl: string): Card[] {
  const out: Card[] = [];
  $('.bem-card').each((_, el) => {
    const $c = $(el);
    const $link = $c.find('.bem-card-descricao a, a.bem-card-descricao').first();
    const href = $link.attr('href') ?? '';
    const m = href.match(/\/lote\/(\d+)/);
    if (!m) return;
    const localTxt = $c.find('.bem-card-localizacao').first().text().replace(/\s+/g, ' ').trim();
    const [cidade, uf] = localTxt.split(',').map((s) => s.trim());
    const foto = $c.find('.bem-card-foto').attr('src') ?? null;
    out.push({
      id: m[1],
      url: href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`,
      titulo: $link.text().replace(/\s+/g, ' ').trim(),
      foto: foto && !/no-image/i.test(foto) ? (foto.startsWith('http') ? foto : `${baseUrl}/${foto.replace(/^\//, '')}`) : null,
      badges: $c.find('.bem-card-status .badge').map((_, b) => $(b).text().trim()).get(),
      avaliacao: dinheiro($c.find('.bem-card-avaliacao h5').first().text()),
      lance: dinheiro($c.find('.bem-card-lance h4').first().text()),
      rotuloLance: $c.find('.bem-card-lance span').first().text().trim() || null,
      cidade: cidade || null,
      uf: uf && campos.ehUf(uf) ? uf.toUpperCase() : null,
    });
  });
  return out;
}

export const leiloar: Connector = {
  def: {
    id: 'leiloar',
    name: 'Plataforma Leiloar',
    platform: 'Leiloar',
    method: 'html',
    tier: 3,
    siteUrl: 'https://plataformaleiloar.com.br',
    notes: 'White-label multi-tenant (CakePHP). POST form-urlencoded em /bens/pesquisaAvancada (raiz ou /externo); paginação por /page:N no path da URL.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    const dominios = await tenants(Number(process.env.LEILOAR_TENANTS ?? 20));
    const cota = Math.max(POR_PAGINA, Math.ceil(limit / Math.max(1, dominios.length)));

    for (const host of dominios) {
      const b = await base(host);
      const baseUrl = `https://${host}${b}`;
      const antes = lots.length;
      let totalAnunciado: number | null = null;

      for (let pagina = 1; lots.length - antes < cota && lots.length < limit; pagina++) {
        const url = pagina === 1 ? `${baseUrl}/bens/pesquisaAvancada` : `${baseUrl}/bens/pesquisaAvancada/page:${pagina}`;
        let r;
        try {
          r = await fetchText(url, {
            method: 'POST',
            headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'data[Bem][termo]=',
            gapMs: 1100,
          });
        } catch {
          break;
        }
        httpStatus = r.status;
        if (r.status !== 200) break;

        totalAnunciado ??= Number(r.body.match(/Exibindo\s+\d+\s+de\s+(\d+)\s+resultados/i)?.[1]) || 0;
        const $ = cheerio.load(r.body);
        const cards = lerCards($, baseUrl);
        if (!cards.length) break;
        fetched += cards.length;

        for (const c of cards) {
          if (!c.titulo || looksLikePart(c.titulo)) {
            skipped++;
            continue;
          }
          const parsed = parseTitle(c.titulo);
          const local = c.cidade && c.uf ? { city: campos.apararCidade(c.cidade), uf: c.uf } : campos.localDeTexto(c.titulo);
          const maiorLance = /atual|maior/i.test(c.rotuloLance ?? '');

          lots.push({
            sourceId: 'leiloar',
            externalId: `${host}:${c.id}`,
            lotUrl: c.url,
            titleRaw: c.titulo,
            brand: parsed.brand,
            model: parsed.model,
            version: parsed.version,
            yearMake: parsed.yearMake,
            yearModel: parsed.yearModel,
            docType: /judicial/i.test(c.titulo) ? 'judicial' : null,
            // Sem categoria própria no card — o único badge de "tipo" é
            // "Eletrônico" (modalidade do leilão, igual em veículo e imóvel).
            // O título é o que sobra: termos de imóvel MEDIDOS no oaleiloes
            // (vaga, subloja, quadra, loteamento — "lote" sozinho é ambíguo com
            // número de lote do próprio leilão, por isso não entra na lista).
            assetType: /apartamento|casa|terreno|im[óo]vel|sala|galp[ãa]o|fazenda|s[íi]tio|ch[áa]cara|cobertura|sobrado|vaga\s+de\s+garagem|subloja|quadra|loteamento|gleba/i.test(c.titulo)
              ? 'imovel'
              : 'veiculo',
            // Praça judicial com data e hora fixa (1ª/2ª praça no mesmo dia,
            // 30 min de intervalo — CPC 891) — nunca timer por lote.
            closingModel: 'pregao_em_horario',
            auctionStartUtc: null,
            auctionEndUtc: null,
            sourceTz: 'America/Sao_Paulo',
            status: statusDe(c.badges),
            currentBid: maiorLance ? c.lance : null,
            minBid: maiorLance ? null : c.lance,
            appraisal: c.avaliacao,
            sellerType: classifySeller(null) as any,
            city: local?.city ?? null,
            state: local?.uf ?? null,
            photos: c.foto ? [c.foto] : [],
            raw: { tenant: host, totalAnunciado, badges: c.badges },
          });
        }
        if (totalAnunciado != null && lots.length - antes >= totalAnunciado) break;
        if (cards.length < POR_PAGINA) break;
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus };
  },
};
