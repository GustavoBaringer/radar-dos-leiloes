import { query } from './db.js';
import { fetchText } from '../connectors/http.js';

// Lance ao vivo lido do Firebase público que o próprio site usa: ~300 bytes por
// lote quente em vez de recoletar o catálogo inteiro. Só o VALOR é lido — o nó
// de lance traz nome e apelido de quem deu o lance, e isso não entra na base.

export interface LoteQuente {
  id: number;
  sourceId: string;
  externalId: string;
  lotUrl: string | null;
  leilaoId: string | null;
  currentBid: number | null;
  fim: Date;
}

export interface Leitura {
  lance: number | null;
  /** Fechamento prorrogado (lance no fim estende o prazo). Só quando a fonte publica. */
  fim?: Date | null;
}

const FIREBASE_TIMEOUT_MS = 8000;

async function lerJson(url: string): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FIREBASE_TIMEOUT_MS) });
  return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
}

const valor = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* ------------------------------------------------------------------ */
/* vlance                                                              */
/* ------------------------------------------------------------------ */

// Exceções copiadas do app do próprio vlance (`t.databaseURL="https://serrano-vlance-"+i`).
const EXCECOES_VLANCE: Record<string, string> = {
  leiloesjudiciaismgnorte: 'leiloesjudiciais-mgnorte',
  joserodovalholeiloes: 'leiloesjudiciais-mgnorte',
  rigolonleiloes: 'rigolon-leiloes',
  mariafixerleiloes: 'mariafixer-leiloes',
  planaltoleiloes: 'planalto-leiloes',
  nortenordesteleiloes: 'cearaleiloes',
  franciscofreitasleiloes: 'cearaleiloes',
  doleiloes: 'danieloliveiraleiloes',
  jrleiloes: 'leiloesjudiciaissul',
  leiloeszanoni: 'leiloesjudiciaissc',
  superaleiloes: 'supera-leiloes',
};

export function bancoPeloDominio(host: string): string {
  const partes = host.toLowerCase().split('.');
  const nome = partes[0] === 'www' || partes[0] === 'www3' ? partes[1] : partes[0];
  return EXCECOES_VLANCE[nome] ?? nome;
}

const baseVlance = (banco: string) => `https://serrano-vlance-${banco}.firebaseio.com`;

/** Banco por leilão. `null` = já procurado e não achado: não procurar de novo nesta vida do worker. */
const bancoDoLeilao = new Map<string, string | null>();
const bancosConhecidos = new Set<string>(['leiloesjudiciaismg', ...Object.values(EXCECOES_VLANCE)]);

async function confirmaBanco(banco: string, leilao: string, lote: string): Promise<boolean> {
  try {
    const r = await lerJson(`${baseVlance(banco)}/status/${leilao}/${lote}.json`);
    return Number(r.data?.lote_id) === Number(lote);
  } catch {
    return false;
  }
}

// MEDIDO em 02/10: o domínio resolve 623 de 682 leilões; o resto exibe leilão de
// outro banco (thaisteixeira → leiloesjudiciaismg), e só testando se acha o dono.
async function resolveBanco(lote: LoteQuente): Promise<string | null> {
  const leilao = lote.leilaoId;
  if (!leilao || !lote.lotUrl) return null;
  if (bancoDoLeilao.has(leilao)) return bancoDoLeilao.get(leilao)!;
  const candidato = bancoPeloDominio(new URL(lote.lotUrl).host);
  let achado: string | null = null;
  if (await confirmaBanco(candidato, leilao, lote.externalId)) achado = candidato;
  else {
    for (const b of bancosConhecidos) {
      if (b === candidato) continue;
      if (await confirmaBanco(b, leilao, lote.externalId)) { achado = b; break; }
    }
  }
  bancoDoLeilao.set(leilao, achado);
  if (achado) bancosConhecidos.add(achado);
  return achado;
}

// `dt_fechamento` vem sem fuso e deslocado pelo `fusohorario` do leilão: MT (−1)
// publica 17:00 para 16:00 de Brasília. Sem isto, 6 de 115 lotes ganhavam 1–2 h.
export function fimDoVlance(s: unknown, fusoHoras: number): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  return new Date(new Date(`${m[1]}T${m[2]}-03:00`).getTime() + fusoHoras * 3_600_000);
}

const fusoDoLeilao = new Map<string, number>();

async function lerVlance(lote: LoteQuente): Promise<Leitura | null> {
  const banco = await resolveBanco(lote);
  if (!banco) return null;
  const base = baseVlance(banco);
  const caminho = `${lote.leilaoId}/${lote.externalId}`;
  if (!fusoDoLeilao.has(lote.leilaoId!)) {
    const f = await lerJson(`${base}/leilao/${lote.leilaoId}/fusohorario.json`);
    fusoDoLeilao.set(lote.leilaoId!, Number(f.data) || 0);
  }
  const [lances, fechamento] = await Promise.all([
    lerJson(`${base}/lance/${caminho}.json?orderBy=${encodeURIComponent('"$key"')}&limitToLast=1`),
    lerJson(`${base}/dtfechamento/${caminho}.json`),
  ]);
  const ultimo = lances.data ? Object.values(lances.data as Record<string, any>)[0] : null;
  return { lance: valor(ultimo?.vl), fim: fimDoVlance(fechamento.data?.dt_fechamento, fusoDoLeilao.get(lote.leilaoId!)!) };
}

/* ------------------------------------------------------------------ */
/* bomvalor                                                            */
/* ------------------------------------------------------------------ */

const BASE_BOMVALOR = 'https://mbv-live-default-rtdb.firebaseio.com';

// `data.tsFechamento` não entra: em 02/10 apontava para 30/09 em lotes que
// fecham em 09/10 (é o fim de uma praça já encerrada, não do lote).
async function lerBomvalor(lote: LoteQuente): Promise<Leitura | null> {
  const r = await lerJson(`${BASE_BOMVALOR}/lote/${lote.externalId}/ultimoLance/vl.json`);
  if (!r.ok) return null;
  return { lance: valor(r.data) };
}

/* ------------------------------------------------------------------ */
/* freitas                                                             */
/* ------------------------------------------------------------------ */

// Endpoint que a página do lote consulta para o lance: uma requisição por lote
// em vez da coleta completa (527 s medidos). Cadeia TLS incompleta, como no conector.
async function lerFreitas(lote: LoteQuente): Promise<Leitura | null> {
  const m = /leilaoId=(\d+)&loteNumero=(\d+)/i.exec(lote.lotUrl ?? '');
  if (!m) return null;
  const r = await fetchText(
    `https://www.freitasleiloeiro.com.br/Leiloes/RetornarMaiorLanceLote?leilaoId=${m[1]}&loteNumero=${m[2]}&modeloRecebePropostas=False`,
    { insecureTls: true, gapMs: 1100 },
  );
  if (r.status !== 200) return null;
  const v = /id="hdMaiorLance"\s+value="([\d.,]+)"/.exec(r.body)?.[1];
  return { lance: v ? valor(v.replace(/\./g, '').replace(',', '.')) : null };
}

export const LEITORES: Record<string, (l: LoteQuente) => Promise<Leitura | null>> = {
  vlance: lerVlance,
  bomvalor: lerBomvalor,
  freitas: lerFreitas,
};

/* ------------------------------------------------------------------ */
/* Cadência                                                            */
/* ------------------------------------------------------------------ */

/** Quanto esperar até ler de novo, pelo tempo que falta para fechar. `null` = fora da janela. */
export function intervaloMs(fim: Date, agora = Date.now()): number | null {
  const falta = fim.getTime() - agora;
  if (falta > 60 * 60_000) return null;
  // Depois do prazo o lote ainda pode ter sido prorrogado: lê mais um pouco antes de soltar.
  if (falta < -3 * 60_000) return null;
  if (falta > 15 * 60_000) return 5 * 60_000;
  if (falta > 5 * 60_000) return 60_000;
  return 15_000;
}

export async function lotesQuentes(fontes: string[]): Promise<LoteQuente[]> {
  const rows = await query<any>(
    `SELECT id, source_id, external_id, lot_url, raw->>'leilaoId' AS leilao_id, current_bid, auction_end_utc
       FROM lots
      WHERE source_id = ANY($1)
        AND status IN ('aberto','agendado')
        AND auction_end_utc BETWEEN now() - interval '3 minutes' AND now() + interval '60 minutes'`,
    [fontes],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sourceId: r.source_id,
    externalId: String(r.external_id),
    lotUrl: r.lot_url,
    leilaoId: r.leilao_id,
    currentBid: r.current_bid == null ? null : Number(r.current_bid),
    fim: new Date(r.auction_end_utc),
  }));
}
