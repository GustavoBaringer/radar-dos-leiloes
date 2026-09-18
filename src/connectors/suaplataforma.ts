/**
 * Plataforma **Sua Plataforma de Leilão** — white-label ASP.NET atrás de
 * Cloudflare, servindo dezenas de leiloeiros com o mesmo contrato.
 *
 * O endpoint é `POST /ApiEngine/GetLotes/{pagina}/{qtd}`, que devolve
 * `{ CountTotal, Lotes: [...] }`.
 *
 * MEDIDO em 16/09/2026, e diferente do levantamento do dia anterior: o
 * `GetBusca` que a spec recomendava hoje responde **200 com corpo vazio** em
 * todos os tenants testados. O que responde é o `GetLotes`. Contrato de fonte
 * não documentada muda sem aviso — por isso o conector checa a forma da
 * resposta em vez de confiar nela.
 */
import { fetchJson } from './http.js';
import { query } from '../core/db.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';
import * as campos from '../core/campos.js';

const PAGINA = 200;

/**
 * Status do lote → canônico. Os rótulos são os medidos em campo, em
 * `GetLoteRealTime[0].Lote_SubStatus_Label`.
 *
 * "Venda Direta" é lote aberto: recebe proposta a qualquer momento. Tratá-lo
 * como encerrado esconderia catálogo que está à venda.
 */
const STATUS: Array<[RegExp, LotStatus]> = [
  [/aberto para lance|venda direta/i, 'aberto'],
  [/aguardando in[ií]cio/i, 'agendado'],
  [/aguardando data/i, 'sem_data'],
  [/arrematad/i, 'vendido'],
  [/encerrad|suspens|prejudicad|retirad|cancelad/i, 'encerrado'],
];
const statusDe = (rotulo: string): LotStatus => STATUS.find(([re]) => re.test(rotulo))?.[1] ?? 'encerrado';
const ATIVOS = new Set<LotStatus>(['aberto', 'agendado', 'sem_data']);

/**
 * Tipo do bem pelo RÓTULO da categoria, nunca pelo `ID_Categoria`.
 *
 * Os ids não são estáveis entre tenants: `destakleiloes` usa `ID_Categoria=85`
 * com o rótulo "Residenciais", enquanto outros usam 55 para a mesma coisa.
 *
 * O que não bater em nenhum grupo é DESCARTADO em vez de cair no classificador
 * genérico — o fallback dele termina em `veiculo/carro`, e "Diversos" viraria
 * carro em silêncio.
 */
function tipoDaCategoria(rotulo: string): AssetType | null {
  const c = String(rotulo ?? '').toLowerCase();
  if (/ve[ií]cul|autom[óo]v|carro|moto|caminh|m[áa]quina/.test(c)) return 'veiculo';
  if (/resid|terreno|comerc|industri|im[óo]v|rural|apartament|casa|gal[pq]/.test(c)) return 'imovel';
  return null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const data = (v: unknown): Date | null => {
  if (!v) return null;
  // A fonte manda hora local de Brasília sem fuso; sem o offset o Node lê como UTC
  // e o lote encerra três horas antes na nossa tela.
  const t = Date.parse(`${String(v).replace(/Z$/, '')}-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
};

/**
 * Fim da praça VIGENTE, escolhida por `PracaAtual`.
 *
 * Fixar sempre a segunda praça erraria o lote que ainda está na primeira, e
 * `DataTermino` sozinho não serve porque some em lote sem praça configurada.
 */
function fimDaPraca(rt: any): Date | null {
  const praca = Number(rt?.PracaAtual ?? 0);
  const campo =
    praca >= 3 ? 'DataHoraEncerramentoTerceiraPraca'
    : praca === 2 ? 'DataHoraEncerramentoSegundaPraca'
    : 'DataHoraEncerramentoPrimeiraPraca';
  // 1900-01-01 é o "vazio" do ASP.NET: vira null, não uma data no passado remoto.
  const d = data(rt?.[campo]) ?? data(rt?.DataTermino);
  return d && d.getUTCFullYear() > 1901 ? d : null;
}

/**
 * Cidade e UF NÃO existem neste endpoint — medido, nem no item nem no bloco de
 * tempo real. Alguns tenants põem no próprio título ("Casa em Diadema/SP"), e é
 * só de lá que dá para tirar. Quem não usa esse padrão fica sem localização, e
 * isso é lacuna declarada: inventar cidade a partir do comitente seria pior.
 */
function localDoTitulo(titulo: string): { city: string | null; state: string | null } {
  const m = /\bem\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][^/|,]{1,40}?)\s*\/\s*([A-Z]{2})\b/.exec(titulo);
  return m ? { city: m[1].trim(), state: m[2] } : { city: null, state: null };
}

/**
 * Título que não descreve o bem. Medido: `Lote` às vezes traz só o número do
 * lote ("001") ou um rótulo interno do leiloeiro ("SIMULADOR"). Entram no
 * índice como anúncio sem sentido e não há como classificá-los.
 */
function tituloImprestavel(t: string): boolean {
  return t.length < 6 || /^[\d\s.\-]+$/.test(t) || /^(simulador|teste|lote)$/i.test(t);
}

function mapLot(l: any, host: string): CanonicalLot | null {
  const id = l?.ID_Leiloes_Lote;
  const titulo = String(l?.Lote ?? '').trim();
  if (!id || !titulo || tituloImprestavel(titulo)) return null;
  const local = localDoTitulo(titulo);
  // Reserva para quando o formato "…, Cidade/UF" do título não aparece.
  const urlLote = l.URLlote ? `https://${host}/${String(l.URLlote).replace(/^\/+/, '')}` : null;
  const complemento = campos.localDeTexto(titulo) ?? campos.localDeTexto(urlLote);

  const rt = Array.isArray(l.GetLoteRealTime) ? l.GetLoteRealTime[0] : null;
  const status = statusDe(String(rt?.Lote_SubStatus_Label ?? ''));
  if (!ATIVOS.has(status)) return null;

  const assetType = tipoDaCategoria(l.Categoria);
  if (!assetType) return null;

  const fotos: string[] = (Array.isArray(l.Fotos) ? l.Fotos : [])
    // `Foto` já vem com a extensão; concatenar ".jpg" produz 404.
    .map((f: any) => (f?.Foto ? `https://${host}/imagens/1200x1200/${f.Foto}` : null))
    .filter(Boolean) as string[];

  return {
    sourceId: 'suaplataforma',
    // O id é sequência POR TENANT: o 3691 existe em dois sites e são lotes
    // diferentes. Sem o prefixo do host eles colidem na chave única e um
    // sobrescreve o outro em silêncio.
    externalId: `${host}:${id}`,
    lotUrl: l.URLlote ? `https://${host}/${String(l.URLlote).replace(/^\/+/, '')}` : null,
    titleRaw: titulo,
    // `LabelModalidade` e não os booleans `IsJudicial`/`IsExtraJudicial`:
    // medido lote com rótulo "Extrajudicial" e os dois booleans em false.
    docType: l.LabelModalidade ? String(l.LabelModalidade) : null,
    sourceCategory: l.Categoria ? String(l.Categoria) : null,
    assetType,
    closingModel: 'timer_por_lote',
    auctionStartUtc: data(rt?.DataInicio),
    auctionEndUtc: fimDaPraca(rt),
    sourceTz: 'America/Sao_Paulo',
    status,
    currentBid: num(rt?.ValorLanceAtual),
    minBid: num(rt?.ProximoLance),
    bidIncrement: num(rt?.ValorIncremento),
    appraisal: num(l.ValorAvaliacao ?? rt?.ValorAvaliacao),
    feesPct: num(rt?.Comissao),
    // A fonte identifica o COMITENTE, não o leiloeiro.
    sellerName: l.Comitente ? String(l.Comitente) : null,
    // O `localDoTitulo` cobre o formato "…, Cidade/UF" do título. Quando ele
    // não acha (83% dos lotes), o garimpo genérico tenta o título inteiro e o
    // slug da URL, que é onde esta fonte guarda o lugar.
    city: local.city ?? complemento?.city ?? null,
    state: local.state ?? complemento?.uf ?? null,
    photos: fotos,
    photoCount: fotos.length,
    // `raw` sem a descrição: é lá que a fonte publica CPF, nome de parte e
    // RENAVAM em claro, e o raw não passa pelo scrub de PII.
    raw: {
      tenant: host,
      praca: rt?.PracaAtual ?? null,
      subStatus: rt?.Lote_SubStatus_Label ?? null,
      leilao: l.CodLeilao ?? null,
      lote: l.LoteNumero ?? null,
      categoriaId: l.ID_Categoria ?? null,
    },
  } as CanonicalLot;
}

/** Tenants: os domínios que a descoberta marcou como desta plataforma. */
async function tenants(limite: number): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'sua-plataforma' AND http_status = 200
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC
      LIMIT $1`,
    [limite],
  );
  // O host serve em www.; o domínio pelado devolve 301, e POST que segue
  // redirect degrada para GET — a resposta viria 200 e vazia.
  return rows.map((r) => (r.domain.startsWith('www.') ? r.domain : `www.${r.domain}`));
}

export const suaplataforma: Connector = {
  def: {
    id: 'suaplataforma',
    name: 'Sua Plataforma de Leilão',
    platform: 'sua-plataforma',
    method: 'api',
    tier: 2,
    siteUrl: 'https://www.destakleiloes.com.br',
    notes:
      'White-label multi-tenant. POST /ApiEngine/GetLotes/{pagina}/{qtd}. Ativos vêm primeiro: para de paginar na primeira página sem ativo. GetBusca responde 200 vazio.',
  },

  async collect({ limit, assetTypes }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;

    for (const host of await tenants(Number(process.env.SUAPLATAFORMA_TENANTS ?? 40))) {
      if (lots.length >= limit) break;

      for (let pagina = 1; pagina <= 40; pagina++) {
        if (lots.length >= limit) break;
        let r;
        try {
          r = await fetchJson<any>(`https://${host}/ApiEngine/GetLotes/${pagina}/${PAGINA}`, {
            method: 'POST',
            gapMs: 1100,
            timeoutMs: 60000,
            headers: { 'content-type': 'application/json', referer: `https://${host}/busca` },
            body: '{}',
          });
        } catch {
          break;
        }
        status = r.status;
        const itens: any[] = r.data?.Lotes ?? [];
        // 200 com corpo vazio é a resposta de tenant morto nesta plataforma —
        // o código HTTP não denuncia, só a forma do corpo.
        if (r.status !== 200 || !Array.isArray(itens) || !itens.length) break;
        fetched += itens.length;

        let ativosNaPagina = 0;
        for (const it of itens) {
          if (lots.length >= limit) break;
          const ativo = ATIVOS.has(statusDe(String(it?.GetLoteRealTime?.[0]?.Lote_SubStatus_Label ?? '')));
          if (ativo) ativosNaPagina++;
          const m = mapLot(it, host);
          if (m && (!assetTypes || assetTypes.includes(m.assetType as string))) lots.push(m);
          else skipped++;
        }

        // MEDIDO: a listagem vem ordenada com os ativos primeiro (página 1 só
        // com aberto/aguardando, página 5 já toda arrematada). Parar na
        // primeira página sem nenhum ativo troca 39 requisições por tenant por
        // 2 a 4 — o catálogo histórico do maior tenant tem 7.625 lotes e 95%
        // deles é encerrado que seria descartado no mapeamento.
        if (!ativosNaPagina) break;
        if (itens.length < PAGINA) break;
      }
    }

    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
