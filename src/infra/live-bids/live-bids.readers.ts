import { fetchText as httpFetchText } from '../../connectors/http.js';
import { bancoPeloDominio, EXCECOES_VLANCE, fimDoVlance } from '../../domain/lots/live-bids.js';
import type { LoteQuente, Leitura } from '../../domain/lots/live-bids.js';

const FIREBASE_TIMEOUT_MS = 8000;
type ReaderIO = {
  fetchText: typeof httpFetchText;
  fetchJson: (url: string, options: { timeoutMs: number }) => Promise<{ status: number; data: any }>;
};

export function createLiveBidReaders(io: ReaderIO = { fetchText: httpFetchText, fetchJson: async (url, options) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
  return { status: r.status, data: r.ok ? await r.json() : null };
} }) {
  const lerJson = async (url: string): Promise<{ ok: boolean; status: number; data: any }> => {
    const r = await io.fetchJson(url, { timeoutMs: FIREBASE_TIMEOUT_MS }); return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.status >= 200 && r.status < 300 ? r.data : null };
  };
  const valor = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const baseVlance = (banco: string) => `https://serrano-vlance-${banco}.firebaseio.com`;
  const bancoDoLeilao = new Map<string, string | null>();
  const bancosConhecidos = new Set<string>(['leiloesjudiciaismg', ...Object.values(EXCECOES_VLANCE)]);
  async function confirmaBanco(banco: string, leilao: string, lote: string): Promise<boolean> {
    try { const r = await lerJson(`${baseVlance(banco)}/status/${leilao}/${lote}.json`); return Number(r.data?.lote_id) === Number(lote); }
    catch { return false; }
  }
  async function resolveBanco(lote: LoteQuente): Promise<string | null> {
    const leilao = lote.leilaoId;
    if (!leilao || !lote.lotUrl) return null;
    if (bancoDoLeilao.has(leilao)) return bancoDoLeilao.get(leilao)!;
    const candidato = bancoPeloDominio(new URL(lote.lotUrl).host);
    let achado: string | null = null;
    if (await confirmaBanco(candidato, leilao, lote.externalId)) achado = candidato;
    else for (const b of bancosConhecidos) { if (b === candidato) continue; if (await confirmaBanco(b, leilao, lote.externalId)) { achado = b; break; } }
    bancoDoLeilao.set(leilao, achado);
    if (achado) bancosConhecidos.add(achado);
    return achado;
  }
  const fusoDoLeilao = new Map<string, number>();
  async function lerVlance(lote: LoteQuente): Promise<Leitura | null> {
    const banco = await resolveBanco(lote);
    if (!banco) return null;
    const base = baseVlance(banco), caminho = `${lote.leilaoId}/${lote.externalId}`;
    if (!fusoDoLeilao.has(lote.leilaoId!)) { const f = await lerJson(`${base}/leilao/${lote.leilaoId}/fusohorario.json`); fusoDoLeilao.set(lote.leilaoId!, Number(f.data) || 0); }
    const [lances, fechamento] = await Promise.all([
      lerJson(`${base}/lance/${caminho}.json?orderBy=${encodeURIComponent('"$key"')}&limitToLast=1`),
      lerJson(`${base}/dtfechamento/${caminho}.json`),
    ]);
    const ultimo = lances.data ? Object.values(lances.data as Record<string, any>)[0] : null;
    return { lance: valor(ultimo?.vl), fim: fimDoVlance(fechamento.data?.dt_fechamento, fusoDoLeilao.get(lote.leilaoId!)!) };
  }
  async function lerBomvalor(lote: LoteQuente): Promise<Leitura | null> {
    const r = await lerJson(`https://mbv-live-default-rtdb.firebaseio.com/lote/${lote.externalId}/ultimoLance/vl.json`);
    return r.ok ? { lance: valor(r.data) } : null;
  }
  async function lerFreitas(lote: LoteQuente): Promise<Leitura | null> {
    const m = /leilaoId=(\d+)&loteNumero=(\d+)/i.exec(lote.lotUrl ?? '');
    if (!m) return null;
    const r = await io.fetchText(`https://www.freitasleiloeiro.com.br/Leiloes/RetornarMaiorLanceLote?leilaoId=${m[1]}&loteNumero=${m[2]}&modeloRecebePropostas=False`, { insecureTls: true, gapMs: 1100 });
    if (r.status !== 200) return null;
    const v = /id="hdMaiorLance"\s+value="([\d.,]+)"/.exec(r.body)?.[1];
    return { lance: v ? valor(v.replace(/\./g, '').replace(',', '.')) : null };
  }
  return { vlance: lerVlance, bomvalor: lerBomvalor, freitas: lerFreitas } as Record<string, (l: LoteQuente) => Promise<Leitura | null>>;
}

export const LEITORES = createLiveBidReaders();
