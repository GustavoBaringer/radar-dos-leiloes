/**
 * Plataforma **Bom Valor** — marketplace único com fachada white-label por leiloeiro.
 *
 * Diferente do soleon e do leiloar, os 11 domínios não são catálogos independentes:
 * eles vendem quase o MESMO acervo. Medido: 5 tenants cobrem 100% dos 690 lotes, e os
 * outros 6 não acrescentam nenhum. Por isso a lista de tenants é curada, não a query.
 *
 * Por baixo é o mesmo fornecedor do nosso `vlance` (bucket `vlance-cdn-v2`, mesma
 * família de nomes de campo), mas o contrato HTTP é outro: o `/core/api/get-lotes`
 * do vlance responde 405 aqui. São dois conectores; o que se compartilha é o
 * tratamento de foto e de praça.
 *
 * Método: `json-embedded`. A busca traz um array com TODOS os lotes num atributo
 * HTML, e a página do lote traz o objeto inteiro num `<script>`.
 */
import { fetchText } from './http.js';
import { query } from '../core/db.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * Tenants que de fato acrescentam catálogo, em ordem de cobertura gulosa medida.
 * É dado, não constante: reavaliar periodicamente rodando os 11 e comparando ids.
 */
const TENANTS_PADRAO = ['leiloei.com', 'multleiloes.com', 'paulotolentino.com.br', 'martinsleiloes.com.br', 'costanetoleiloeiro.com.br'];

const SEGMENTO: Record<string, AssetType> = { veiculos: 'veiculo', imoveis: 'imovel' };

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Status do lote. `pracas[].status` é o campo estável; `nm_statuslote` é o rótulo.
 * Código não observado NÃO vira encerrado — a listagem só traz data futura ou de
 * hoje, então o desconhecido é mais provavelmente aberto, e o job de encerramento
 * corrige pelo relógio depois. O bruto vai para `raw`.
 */
function statusDe(praca: any, lote: any): LotStatus {
  const s = String(praca?.status ?? lote?.nm_statuslote ?? '').toLowerCase();
  if (/nao-vendido|não vendido|deserto/.test(s)) return 'encerrado';
  if (/arremat|vendid/.test(s)) return 'vendido';
  if (/aguardando/.test(s)) return 'agendado';
  return 'aberto';
}

/**
 * A praça vigente. Fixar sempre a primeira põe data e valor da praça errada num lote
 * que já passou para a segunda.
 */
function pracaVigente(pracas: any[]): any | null {
  if (!Array.isArray(pracas) || !pracas.length) return null;
  return (
    pracas.find((p) => p?.em_pregao || p?.statuspracaatual_id) ??
    pracas.find((p) => !/nao-vendido/.test(String(p?.status ?? ''))) ??
    pracas[0]
  );
}

/**
 * Extrai `sharedData = {...}` do HTML.
 *
 * É objeto JS, não JSON: as chaves de primeiro nível vêm sem aspas. O valor de `lote`
 * é JSON puro, então basta citar as chaves do topo antes do parse.
 */
function lerSharedData(html: string): any | null {
  const i = html.indexOf('sharedData');
  if (i < 0) return null;
  const abre = html.indexOf('{', i);
  if (abre < 0) return null;
  // Casamento de chaves respeitando string e escape — cortar no primeiro '}'
  // pegaria o fim do primeiro objeto aninhado.
  let nivel = 0;
  let emString: string | null = null;
  let escapado = false;
  for (let k = abre; k < html.length; k++) {
    const c = html[k];
    if (emString) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === emString) emString = null;
      continue;
    }
    if (c === '"' || c === "'") emString = c;
    else if (c === '{') nivel++;
    else if (c === '}' && --nivel === 0) {
      const bruto = html.slice(abre, k + 1).replace(/^(\s*)(\w+)\s*:/gm, '$1"$2":');
      try {
        return JSON.parse(bruto);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Lotes da listagem: o atributo `data-lote` traz o array inteiro da página. */
function lerListagem(html: string): any[] {
  const m = /id="info-lote-mapa"[^>]*data-lote="([^"]+)"/.exec(html);
  if (!m) return [];
  const texto = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  try {
    const d = JSON.parse(texto);
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

const idDoSlug = (slug: string): string | null => /-(\d+)$/.exec(String(slug ?? ''))?.[1] ?? null;

function mapLot(item: any, detalhe: any, host: string): CanonicalLot | null {
  const slug = String(item?.nm_slug ?? '');
  const id = idDoSlug(slug);
  const titulo = String(item?.nm_titulo ?? detalhe?.nm_titulo ?? '').trim();
  if (!id || !titulo) return null;

  const assetType = SEGMENTO[slug.split('/')[0]] ?? null;
  // Só veículo e imóvel entram: 353 dos 690 são máquinas e equipamentos, fora do escopo.
  if (!assetType) return null;

  const praca = pracaVigente(detalhe?.pracas);
  const leilao = detalhe?.leilao ?? {};
  const loc = item?.localizacao ?? {};
  const veic = detalhe?.vistoria?.veiculo ?? {};

  // O CDN serve só dois tamanhos; 800x600 e 1200x1200 devolvem 404 do S3.
  const fotos: string[] = (Array.isArray(item?.fotos) ? item.fotos : [])
    .map((f: any) => String(f).replace('/327x244/', '/640x480/'))
    .filter(Boolean);

  // `dt_timestamp` é o instante real de fechamento. `timestamp_encerramento` é a DATA
  // convertida e cai à meia-noite — usá-lo antecipa o catálogo inteiro em 14 horas.
  const fim = num(leilao.dt_timestamp) ? new Date(Number(leilao.dt_timestamp) * 1000) : null;
  const inicio = num(leilao.timestamp_abertura) ? new Date(Number(leilao.timestamp_abertura) * 1000) : null;

  return {
    sourceId: 'bomvalor',
    // Id GLOBAL: o mesmo número devolve o mesmo lote em tenants diferentes (testado
    // em três). Sem prefixo de host, ao contrário do soleon — e a sobreposição entre
    // fachadas é resolvida de graça pela chave única.
    externalId: id,
    lotUrl: `https://${host}/${slug.replace(/^\/+/, '')}`,
    titleRaw: titulo,
    assetType,
    sourceCategory: detalhe?.categoria?.nm_categoria ?? slug.split('/')[1] ?? null,
    sourceGroup: detalhe?.segmento?.nm_segmento ?? null,
    brand: veic.nm_marca ?? null,
    model: veic.nm_modelo ?? null,
    yearMake: num(veic.nu_anofabricacao),
    yearModel: num(veic.nu_anomodelo),
    km: num(veic.nu_km),
    color: veic.nm_cor ?? null,
    fuel: veic.nm_statuscombustivel ?? null,
    closingModel: 'pregao_em_horario',
    auctionStartUtc: inicio,
    auctionEndUtc: fim,
    sourceTz: 'America/Sao_Paulo',
    status: statusDe(praca, detalhe),
    // `vl_lanceminimo` veio "0.00" em toda a amostra; o valor que vale é o inicial.
    minBid: num(detalhe?.vl_lanceinicial ?? praca?.vl_lanceinicial),
    currentBid: num(praca?.vl_ultimolance),
    bidIncrement: num(detalhe?.vl_incremento),
    appraisal: num(leilao.vl_avaliacaoempresa),
    feesPct: num(detalhe?.nu_comissaoarrematantelote),
    // `nome_leiloeiro` é o leiloeiro do TENANT, não do lote: o mesmo id sai com três
    // nomes diferentes conforme a fachada. O estável é o comitente.
    sellerName: detalhe?.judicial?.nm_comitente ?? null,
    sellerType: detalhe?.judicial ? 'judicial' : null,
    docType: detalhe?.rede?.nm_rede_rota === 'judicial' ? 'judicial' : null,
    city: loc.nm_cidade ?? null,
    state: loc.nm_estado ?? null,
    yard: loc.nm_endereco ?? null,
    photos: fotos,
    photoCount: fotos.length,
    // `raw` sem descrição, sem o bloco judicial e sem lances: é onde moram nome de
    // parte, CPF, nome de juiz e identificação de licitante, e o raw não passa por scrub.
    raw: {
      tenant: host,
      praca: praca?.nu_praca ?? null,
      statusBruto: praca?.status ?? detalhe?.nm_statuslote ?? null,
      statusLoteId: detalhe?.statuslote_id ?? null,
      leilaoId: detalhe?.leilao_id ?? null,
      rede: detalhe?.rede?.nm_redealias ?? null,
    },
  } as CanonicalLot;
}

async function tenants(): Promise<string[]> {
  const env = String(process.env.BOMVALOR_TENANTS ?? '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  // A lista curada é o padrão; o banco entra só como rede de segurança caso os
  // domínios mudem de nome.
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites WHERE platform='bomvalor' AND http_status=200 AND has_lots IS NOT FALSE`,
  );
  const conhecidos = new Set(rows.map((r) => r.domain));
  const usar = TENANTS_PADRAO.filter((d) => conhecidos.has(d));
  return usar.length ? usar : TENANTS_PADRAO;
}

export const bomvalor: Connector = {
  def: {
    id: 'bomvalor',
    name: 'Bom Valor',
    platform: 'bomvalor',
    method: 'json-embedded',
    tier: 2,
    siteUrl: 'https://leiloei.com',
    notes:
      'Marketplace único com fachadas por leiloeiro: 5 tenants cobrem 100% do catálogo, os outros 6 não acrescentam nada. Listagem traz o acervo num atributo; preço e data exigem o detalhe.',
  },

  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const vistos = new Set<string>();

    for (const host of await tenants()) {
      if (lots.length >= limit) break;
      let r;
      try {
        // Uma requisição traz o catálogo inteiro do tenant. Medido: 3,9 a 5,0 MB
        // e 43 a 56 segundos — por isso o timeout é generoso.
        r = await fetchText(`https://${host}/busca?perPage=1000&page=1`, {
          headers: { 'user-agent': UA },
          gapMs: 1100,
          timeoutMs: 120000,
        });
      } catch {
        continue;
      }
      status = r.status;
      if (r.status !== 200) continue;

      const itens = lerListagem(r.body);
      fetched += itens.length;

      for (const it of itens) {
        if (lots.length >= limit) break;
        const slug = String(it?.nm_slug ?? '');
        const id = idDoSlug(slug);
        // O id é global: o mesmo lote aparece em várias fachadas e só a primeira conta.
        if (!id || vistos.has(id)) continue;
        const seg = SEGMENTO[slug.split('/')[0]] ?? null;
        if (!seg || (assetTypes && !assetTypes.includes(seg))) {
          skipped++;
          continue;
        }
        vistos.add(id);

        // Preço, data e status só existem no detalhe — a listagem não os traz. Sem
        // isto o lote entraria sem prazo e sem valor, que é o que o produto vende.
        let detalhe: any = null;
        try {
          const d = await fetchText(`https://${host}/${slug.replace(/^\/+/, '')}`, {
            headers: { 'user-agent': UA },
            gapMs: 1100,
            timeoutMs: 45000,
          });
          if (d.status === 200) detalhe = lerSharedData(d.body)?.lote ?? null;
        } catch {
          /* sem detalhe o lote ainda entra, com o que a listagem deu */
        }

        const m = mapLot(it, detalhe, host);
        if (m) lots.push(m);
        else skipped++;
      }
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
