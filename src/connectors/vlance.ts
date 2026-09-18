import { fetchJson } from './http.js';
import * as campos from '../core/campos.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, looksLikePart } from '../core/normalize.js';
import { query } from '../core/db.js';

/**
 * Plataforma **vlance**: o mesmo contrato `/core/api/get-lotes` roda em dezenas
 * de leiloeiros. O Leilões Judiciais (Serrano) é só o maior tenant dela — foi
 * por onde descobrimos a API. Um conector serve todos: só troca o host.
 */
const caminhoApi = (host: string) => `https://${host}/core/api/get-lotes`;
/**
 * A foto NÃO fica no domínio do site: a API entrega a URL de S3 pronta em
 * `nm_path_completo`, já com uma pasta de tamanho no caminho. Montar
 * `site/fotos/<nm_path>` dá 404 — e como o proxy cai para o nopic, o lote
 * aparecia com "sem foto" mesmo tendo photo_count > 0.
 *
 * Tamanhos disponíveis: 107x80, 196x146, 327x244 e 640x480. O caminho sem
 * pasta de tamanho responde 403, então 640x480 é o teto real.
 */
const TAMANHO_FOTO = '640x480';

/**
 * API JSON pública, sem autenticação, comum a todos os tenants vlance.
 *
 * Três coisas medidas em 14/09/2026:
 *  1. É **POST com os parâmetros na querystring**. Um GET responde HTTP 200 com
 *     `{"mensagem":"Metodo não permitido!"}` — status de sucesso para uma recusa,
 *     então checar só o código HTTP daria falso positivo.
 *  2. `nm_usuario` e `id_usuario` identificam o LICITANTE. É dado pessoal e não
 *     entra no índice.
 *  3. Há lotes de teste no meio ("Leilão simulação", fechamento em 2040), que
 *     precisam ser descartados ou viram lote fantasma no topo da ordenação.
 *
 * E uma quarta, medida em 15/09/2026 ao virar multi-tenant:
 *  4. Alguns hosts respondem 301 para OUTRO tenant. Seguir o redirect degrada o
 *     POST para GET e a API devolve "Metodo não permitido!" com HTTP 200. Por
 *     isso o host é resolvido antes, e a chamada não segue redirecionamento.
 */

const TIPOS: Record<number, 'veiculo' | 'imovel'> = { 1: 'veiculo', 3: 'imovel' };

function texto(html?: string | null): string {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function num(v: any): number | null {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * O caminho tem TRÊS segmentos, não dois: `/leilao/index/leilao_id/{X}/lote/{Y}`.
 * O `/lote/{X}/{Y}` que eu usava antes dava 404 em quase todo tenant, e por isso
 * havia uma allowlist mandando os demais para a home. Validado por renderização
 * em 6 tenants (o portal é SPA, então 200 no HTML não prova nada): lote real
 * desenha 2-7 mil caracteres, id inexistente desenha ~1 mil e diz "não encontrado".
 */
function urlDoLote(l: any, hostConsultado: string): string {
  // `nm_url_leiloeiro` é o host DONO do lote, que nem sempre é o que consultamos:
  // o mesmo lote aparece no catálogo de vários tenants.
  const dono = String(l.nm_url_leiloeiro ?? hostConsultado).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const base = dono.replace(/^api\./, 'www.');
  const lote = l.lote_id ?? l.id;
  if (!l.leilao_id || !lote) return `https://${base}/`;
  return `https://${base}/leilao/index/leilao_id/${l.leilao_id}/lote/${lote}`;
}

/**
 * A fonte publica as duas praças e não diz qual está aberta. O lance atual
 * denuncia: se já passou do piso da segunda, é nela que o leilão está.
 */
function minimoDaPracaVigente(primeira: number | null, segunda: number | null, atual: number | null): number | null {
  const candidatos = [primeira, segunda].filter((v): v is number => v != null);
  if (!candidatos.length) return null;
  if (atual == null) return primeira ?? segunda;
  // O menor piso que o lance atual respeita é o da praça vigente.
  const cabem = candidatos.filter((v) => atual >= v);
  if (cabem.length) return Math.max(...cabem);
  // Nenhum dos dois cabe: o mínimo publicado está velho. Preferimos não
  // publicar mínimo a publicar um contraditório — campo ausente a tela sabe
  // explicar, "mínimo acima do lance atual" ninguém sabe.
  return null;
}

function mapLot(l: any, asset: 'veiculo' | 'imovel', host: string): CanonicalLot | null {
  const titulo = (l.nm_titulo_lote ?? '').trim() || texto(l.nm_descricao).slice(0, 140);
  if (!titulo) return null;
  if (asset === 'veiculo' && looksLikePart(titulo)) return null;
  // Lote de simulação da própria plataforma.
  if (/simula[çc][ãa]o|\bteste\b/i.test(`${l.nm_titulo_leilao ?? ''} ${titulo}`)) return null;

  const fim = l.dt_fechamento ? new Date(l.dt_fechamento) : null;
  // Fechamento em 2040 é marcador de lote de teste, não leilão real.
  if (fim && fim.getUTCFullYear() > new Date().getUTCFullYear() + 3) return null;

  const parsed = asset === 'veiculo' ? parseTitle(titulo) : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const fotos: string[] = Array.isArray(l.fotos)
    ? l.fotos
        .map((f: any) => {
          if (f?.nm_path_incompleto && f?.nm_path) return `${f.nm_path_incompleto}${TAMANHO_FOTO}/${f.nm_path}`;
          // Fallback: troca a pasta de tamanho da URL que a API já entrega pronta.
          if (f?.nm_path_completo) return String(f.nm_path_completo).replace(/\/\d+x\d+\//, `/${TAMANHO_FOTO}/`);
          return null;
        })
        .filter(Boolean)
        .slice(0, 20)
    : [];

  return {
    sourceId: 'vlance',
    // MEDIDO: o `lote_id` é GLOBAL da plataforma, não do tenant. O mesmo lote
    // aparece em até 3 hosts (vitrine do leiloeiro + alias *.leilao.br + parceiro),
    // sempre com o mesmo título. Prefixar com o host inflava a base em ~30%:
    // o id sozinho é a chave certa e deduplica sozinho.
    externalId: String(l.lote_id ?? l.id),
    // A URL pública tem DOIS segmentos: leilão e lote. Com um só, a SPA
    // responde 200 e renderiza "Leilão não encontrado" — o status não denuncia.
    lotUrl: urlDoLote(l, host),
    titleRaw: titulo,
    assetType: asset,
    sourceCategory: asset === 'imovel' ? 'imovel' : null,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    docType: 'judicial',
    // A API dá o fechamento do lote, então há timer próprio.
    closingModel: 'timer_por_lote',
    auctionStartUtc: null,
    auctionEndUtc: fim,
    sourceTz: 'America/Sao_Paulo',
    status: fim && fim.getTime() < Date.now() ? 'encerrado' : 'aberto',
    currentBid: num(l.vl_lance),
    // Lance mínimo da praça VIGENTE, não da primeira. Gravar sempre a primeira
    // punha 89 de 109 lotes com mínimo ACIMA do lance atual (medido), o que é
    // impossível e aparecia na tela como "lance R$ 106.400 / mínimo R$ 208.800".
    // A segunda praça só vale quando o lance atual já a alcançou: sem lance,
    // ou com lance ainda na primeira, a primeira continua sendo o mínimo.
    minBid: minimoDaPracaVigente(
      num(l.vl_lanceminimo) ?? num(l.vl_lanceinicial),
      num(l.vl_lanceinicialsegundoleilao),
      num(l.vl_lance),
    ),
    bidIncrement: num(l.vl_incremento),
    appraisal: num(l.vl_venda),
    // Vem no MESMO item do get-lotes, ao lado de `nm_url_leiloeiro`. É dado por
    // LOTE, não do tenant: api.leiloesjudiciais.com.br é catálogo agregado e
    // serve leiloeiros diferentes na mesma resposta.
    auctioneerName: campos.nomeDeLeiloeiro(l.nm_leiloeiro),
    sellerName: 'Justiça (leilão judicial)',
    sellerType: 'judicial',
    city: l.nm_cidade ?? null,
    state: l.nm_estado ?? null,
    photos: fotos,
    raw: {
      tenant: host,
      leilaoId: l.leilao_id,
      leilao: l.nm_titulo_leilao,
      lote: l.nu,
      lances: l.nu_qtdelances,
      segundaPraca: num(l.vl_lanceinicialsegundoleilao),
      parcelas: l.nu_parcelas,
      anexos: Array.isArray(l.anexos) ? l.anexos.length : 0,
      // nm_usuario/id_usuario existem na resposta e NÃO são gravados: licitante.
    },
  };
}

/** Tenants vlance, do catálogo de descoberta. O maior vem primeiro. */
async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'vlance' AND http_status = 200
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC
      LIMIT $1`,
    [limite],
  );
  const lista = rows.map((r) => r.domain);
  // MEDIDO: no Serrano a API mora em `api.`, não no host do site — `www` devolve
  // 404 e o domínio sem prefixo devolve 301. O catálogo tem só os tenants menores,
  // então o maior entra explicitamente.
  if (!lista.includes('api.leiloesjudiciais.com.br')) lista.unshift('api.leiloesjudiciais.com.br');
  return lista;
}

export const vlance: Connector = {
  def: {
    id: 'vlance',
    name: 'Plataforma vlance',
    platform: 'vlance',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.leiloesjudiciais.com.br',
    notes:
      'White-label multi-tenant. POST /core/api/get-lotes com params na querystring; GET devolve 200 com recusa no corpo. Não seguir redirect: degrada POST para GET.',
  },
  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;

    const tipos = Object.entries(TIPOS).filter(([, a]) => !assetTypes || assetTypes.includes(a));
    const dominios = await tenants(Number(process.env.VLANCE_TENANTS ?? 40));

    // Sem cota por tenant: esta API devolve o catálogo inteiro numa requisição,
    // então limitar por tenant só serve para cortar o maior deles (o Serrano
    // sozinho tem 3,5 mil lotes e sumia com cota de 150).
    for (const host of dominios) {
      for (const [tipo, asset] of tipos) {
        if (lots.length >= limit) break;
        let resp;
        try {
          // A API IGNORA qualquer parâmetro de página (`pagina`, `page`, `offset`):
          // `currentPage` volta 1 sempre e repete os mesmos itens. O que funciona
          // é pedir tudo de uma vez com `qtd_por_pagina` alto.
          resp = await fetchJson<any>(`${caminhoApi(host)}?tipo=${tipo}&qtd_por_pagina=5000`, {
            method: 'POST',
            gapMs: 900,
            timeoutMs: 45000,
          });
        } catch {
          break;
        }
        status = resp.status;
        const itens: any[] = resp.data?.items ?? [];
        if (!Array.isArray(itens)) break;
        fetched += itens.length;
        for (const it of itens) {
          if (lots.length >= limit) break;
          const m = mapLot(it, asset, host);
          if (m) lots.push(m);
          else skipped++;
        }
      }
      if (lots.length >= limit) break;
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
