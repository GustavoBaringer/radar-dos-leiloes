import { rotateTenants } from './tenant-rotation.js';
import { isIP } from 'node:net';
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
import { fetchJson, type FetchOpts } from './http.js';
import { query } from '../core/db.js';
import type { CanonicalLot, AssetType, LotStatus } from '../core/types.js';
import type { Connector, CollectResult } from './types.js';
import * as campos from '../core/campos.js';
import { CollectionCancellationError, throwIfCancelled } from '../infra/collection/collection-cancellation.js';
import type { CollectOptions } from './types.js';

const PAGINA = 200;

function leiloeiroDoHost(host: string): string {
  return host
    .replace(/^www\./, '')
    .replace(/\.(com\.br|com|lel\.br|leilao\.br)$/i, '')
    .replace(/leiloes?|leiloeiro/gi, ' Leilões ')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Status do lote → canônico. Os rótulos são os medidos em campo, em
 * `GetLoteRealTime[0].Lote_SubStatus_Label`.
 *
 * "Venda Direta" é lote aberto: recebe proposta a qualquer momento. Tratá-lo
 * como encerrado esconderia catálogo que está à venda.
 */
const STATUS: Array<[RegExp, LotStatus]> = [
  [/aberto para (?:lance|proposta)|venda direta/i, 'aberto'],
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

function isDemo(l: any): boolean {
  const lote = String(l?.Lote ?? '');
  const leilao = String(l?.Leilao ?? '');
  const url = String(l?.URLlote ?? '');
  const texto = `${lote} ${leilao} ${url}`;
  return (
    /\b(?:simulador|simula[cç][aã]o|treinamento|homologa[cç][aã]o)\b/i.test(texto) ||
    /\b(?:leil[aã]o|lote)\s+(?:de\s+)?teste\b/i.test(texto) ||
    /\bteste\b/i.test(lote) ||
    /\bteste\b/i.test(leilao)
  );
}

function mapLot(l: any, host: string): CanonicalLot | null {
  const id = l?.ID_Leiloes_Lote;
  if (!id || isDemo(l)) return null;
  let titulo = String(l?.Lote ?? '').trim();
  if (tituloImprestavel(titulo)) {
    const slug = (() => {
      try {
        const m = l.URLlote?.match(/\/lote\/([^/]+)/);
        if (m) return decodeURIComponent(m[1]).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
      } catch {}
      return '';
    })();
    const leilao = String(l?.Leilao ?? '').trim();
    titulo = !tituloImprestavel(leilao) ? leilao : (!tituloImprestavel(slug) ? slug : titulo);
  }
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

  const fotos: string[] = [
    ...(Array.isArray(l.Fotos) ? l.Fotos : []).map((f: any) =>
      f?.Foto ? `https://${host}/imagens/1200x1200/${f.Foto}` : null,
    ),
    ...(Array.isArray(l.FotosLista) ? l.FotosLista : []).map((f: any) =>
      f?.Foto ? `https://${host}/imagens/1200x1200/${f.Foto}` : null,
    ),
  ]
    .map((x) => x)
    .filter((x, i, a): x is string => !!x && a.indexOf(x) === i);

  return {
    sourceId: 'suaplataforma',
    // O id é sequência POR TENANT: o 3691 existe em dois sites e são lotes
    // diferentes. Sem o prefixo do host eles colidem na chave única e um
    // sobrescreve o outro em silêncio.
    externalId: `${host}:${id}`,
    lotUrl: l.URLlote ? `https://${host}/${String(l.URLlote).replace(/^\/+/, '')}` : null,
    titleRaw: (() => {
      const t = titulo;
      if (t && !/^\s*(judicial|extrajudicial)\s*$/i.test(t.trim()) && t.trim().length > 10) return t;
      try {
        const m = l.URLlote?.match(/\/lote\/([^/]+)/);
        if (m) {
          const slug = decodeURIComponent(m[1]).replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
          if (slug) return slug.toUpperCase();
        }
      } catch {}
      return t;
    })(),
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
    auctioneerName: leiloeiroDoHost(host),
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
const TENANT_ALIASES: Record<string, string> = {
  'tezaleiloes.com.br': 'teza.com.br',
};

const REVIEWED_TENANTS = new Set([
  'teza.com.br',
]);

function raizDomain(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 253 || /[^\x21-\x7e]/.test(value) || /[/:@?#\\]/.test(value)) {
    throw new Error('Invalid tenant domain');
  }
  const host = value.replace(/\.$/, '').toLowerCase().replace(/^www\./, '');
  if (!host || isIP(host) || !host.includes('.') || host.split('.').some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid tenant domain');
  return host;
}

function resolveTenantDomain(value: string): string {
  const root = raizDomain(value);
  return TENANT_ALIASES[root] ?? root;
}

async function tenants(limite: number, tenant: string | undefined, lookup: (sql: string, params?: any[]) => Promise<any[]>): Promise<string[]> {
  const requestedRoot = tenant === undefined ? undefined : resolveTenantDomain(tenant);
  const explicitos = String(process.env.SUAPLATAFORMA_DOMAINS ?? '').trim();
  const rows = explicitos
    ? explicitos.split(',').map((d) => d.trim()).filter(Boolean).map((domain) => ({ domain }))
    : await lookup(
    `SELECT domain FROM discovered_sites
      WHERE platform = 'sua-plataforma' AND http_status = 200
      ORDER BY has_lots DESC NULLS LAST, auctioneers DESC, domain`,
  );
  // O host serve em www.; o domínio pelado devolve 301, e POST que segue
  // redirect degrada para GET — a resposta viria 200 e vazia.
  const population = rows.map((r) => `www.${raizDomain(r.domain)}`);
  for (const reviewed of REVIEWED_TENANTS) {
    const host = `www.${reviewed}`;
    if (!population.includes(host)) population.push(host);
  }
  if (requestedRoot !== undefined) {
    const match = population.find((host) => raizDomain(host) === requestedRoot);
    if (!match) throw new Error(`single-tenant '${tenant}' fora da população elegível de suaplataforma`);
    return [match];
  }
  return rotateTenants(population, limite);
}

export async function collectSuaPlataforma(
  { limit, assetTypes, observer, tenant }: CollectOptions,
  io: {
    fetchJson: (url: string, opts?: FetchOpts) => Promise<{ status: number; data: any; raw: string }>;
    query: (sql: string, params?: any[]) => Promise<any[]>;
  } = { fetchJson, query },
): Promise<CollectResult> {
  const lots: CanonicalLot[] = [];
  let fetched = 0;
  let skipped = 0;
  let httpStatus = 0;
  const allNotes: string[] = [];

  for (const host of await tenants(Number(process.env.SUAPLATAFORMA_TENANTS ?? 40), tenant, io.query)) {
    throwIfCancelled();
    if (lots.length >= limit) break;
    const attempt = await observer?.start(raizDomain(host));
    const antes = lots.length, fetchedAntes = fetched, skippedAntes = skipped;
    let truncated = false;
    let totalObservado: number | null = null;
    const tenantNotes: string[] = [];

    try {
      let totalPaginas = 40;
      let paginasNecessarias = 1;
      for (let pagina = 1; pagina <= totalPaginas; pagina++) {
        throwIfCancelled();
        if (lots.length >= limit) {
          truncated = true;
          tenantNotes.push(`limite de ${limit} lotes atingido`);
          break;
        }

        let r;
        try {
          r = await io.fetchJson(`https://${host}/ApiEngine/GetLotes/${pagina}/${PAGINA}`, {
            method: 'POST', gapMs: 1100, timeoutMs: 60000,
            headers: { 'content-type': 'application/json', referer: `https://${host}/busca` }, body: '{}',
          });
        } catch (error) {
          if (error instanceof CollectionCancellationError) throw error;
          throwIfCancelled();
          attempt?.failure('network');
          truncated = true;
          tenantNotes.push(`falha de rede na página ${pagina} de ${host}`);
          break;
        }

        throwIfCancelled();
        attempt?.response(r.status);
        httpStatus = r.status;
        if (r.status !== 200) {
          attempt?.failure('network');
          truncated = true;
          tenantNotes.push(`HTTP ${r.status} na página ${pagina} de ${host}`);
          break;
        }

        const data = r.data;
        if (!data || !Array.isArray(data.Lotes) || !Number.isSafeInteger(data.CountTotal) || data.CountTotal < 0) {
          attempt?.failure('parser');
          truncated = true;
          tenantNotes.push(`schema inválido em ${host}: CountTotal/Lotes ausentes ou malformados`);
          break;
        }

        const total = Number(data.CountTotal);
        totalObservado = total;
        paginasNecessarias = Math.max(1, Math.ceil(total / PAGINA));
        totalPaginas = Math.min(40, paginasNecessarias);

        const itens: any[] = data.Lotes;
        const tenantFetchedAntes = fetched - fetchedAntes;
        if (!itens.length) {
          if (total > 0 && tenantFetchedAntes < total) {
            truncated = true;
            tenantNotes.push(`página ${pagina} vazia em ${host} com ${tenantFetchedAntes}/${total} coletados`);
          }
          break;
        }

        fetched += itens.length;

        for (const it of itens) {
          throwIfCancelled();
          if (lots.length >= limit) {
            truncated = true;
            tenantNotes.push(`limite de ${limit} lotes atingido`);
            break;
          }
          const m = mapLot(it, host);
          if (m && (!assetTypes || assetTypes.includes(m.assetType as string))) lots.push(m);
          else skipped++;
        }

        if (truncated) break;
        if (lots.length >= limit) {
          truncated = true;
          tenantNotes.push(`limite de ${limit} lotes atingido`);
          break;
        }

        const tenantFetched = fetched - fetchedAntes;
        if (itens.length < PAGINA) {
          if (tenantFetched < total) {
            truncated = true;
            tenantNotes.push(`página ${pagina} retornou apenas ${itens.length} itens mas total observado é ${total}`);
          }
          break;
        }

        if (pagina === 40 && paginasNecessarias > 40) {
          truncated = true;
          tenantNotes.push(`teto de 40 páginas atingido; total observado é ${total}`);
          break;
        }

        if (pagina >= totalPaginas) break;
      }

      const tenantFetchedFinal = fetched - fetchedAntes;
      if (totalObservado !== null && totalObservado > 0 && tenantFetchedFinal < totalObservado && !truncated) {
        truncated = true;
        tenantNotes.push(`coletados ${tenantFetchedFinal} de ${totalObservado} observados`);
      }
    } catch (error) {
      if (error instanceof CollectionCancellationError) {
        attempt?.failure(error.kind === 'deadline' ? 'budget' : 'network');
        tenantNotes.push(`cancelamento por ${error.kind}`);
      } else {
        attempt?.failure('parser');
        tenantNotes.push(`falha: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      await attempt?.finish({
        fetched: fetched - fetchedAntes,
        skipped: skipped - skippedAntes,
        returned: lots.length - antes,
        truncated,
      });
      if (tenantNotes.length) allNotes.push(...tenantNotes);
    }
  }

  const note = allNotes.length ? allNotes.join('; ') : undefined;
  return { lots: lots.slice(0, limit), fetched, skipped, httpStatus, ...(note ? { note } : {}) };
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

  async collect(opts): Promise<CollectResult> { return collectSuaPlataforma(opts); },
};
