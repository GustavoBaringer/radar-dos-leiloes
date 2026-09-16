/**
 * Descoberta de leiloeiro e de plataforma, como rotina em vez de script solto.
 *
 * Ficou fora da fila até 15/09/2026: o catálogo era uma foto tirada à mão, e
 * leiloeiro que se credencia depois nunca entrava sozinho. Pior, leiloeiro que
 * troca de plataforma continua classificado na antiga — e como um conector
 * serve dezenas de sites, classificação velha é lote que existe e não coletamos.
 */
import { query } from './db.js';
import { fetchJson } from '../connectors/http.js';
import { request, Agent, interceptors } from 'undici';
import { startRun, finishRun } from './repo.js';

const BASE_FENAJU = 'https://www.fenaju.org.br/api/public/leiloeiros';
const GRATUITOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.br', 'yahoo.com', 'bol.com.br',
  'uol.com.br', 'terra.com.br', 'ig.com.br', 'live.com', 'icloud.com', 'globo.com', 'me.com',
]);

function host(v?: string | null): string | null {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || s.includes('@')) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

function hostDoEmail(email?: string | null): string | null {
  const m = String(email ?? '').toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  const h = m[1].replace(/^www\./, '');
  return GRATUITOS.has(h) ? null : h;
}

export interface ResultadoFenaju {
  leiloeiros: number;
  comLeilaoBr: number;
  sitesNoCatalogo: number;
  aSondar: number;
}

export async function descobrirFenaju(): Promise<ResultadoFenaju> {
  const todos: any[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data } = await fetchJson<any>(`${BASE_FENAJU}?page=${page}&limit=20`, { gapMs: 300 });
    const itens: any[] = data?.data ?? [];
    todos.push(...itens);
    totalPages = Number(data?.totalPages ?? 1);
    if (!itens.length) break;
    page++;
  } while (page <= totalPages);

  let comLeilaoBr = 0;
  const sites = new Map<string, { ufs: Set<string>; n: number }>();

  for (const l of todos) {
    const declarado = host(l.dominio);
    const doEmail = declarado ? null : hostDoEmail(l.email);
    const domain = declarado ?? doEmail;
    const domLeilao = host(l.dominio_url);
    if (domLeilao) comLeilaoBr++;
    const uf = String(l.juntaUF ?? '').toUpperCase().slice(0, 2) || null;

    await query(
      `INSERT INTO auctioneers (registry, external_id, name, matricula, junta, uf, situacao, domain, domain_origin,
                                uf_junta, ano_posse, credenciamento, associado, nivel, dominio_leilao)
       VALUES ('fenaju',$1,$2,$3,$4,$5,$6,$7,$8,$5,$9,$10,$11,$12,$13)
       ON CONFLICT (registry, external_id) DO UPDATE SET
         name=EXCLUDED.name, matricula=EXCLUDED.matricula, junta=EXCLUDED.junta, uf=EXCLUDED.uf,
         situacao=EXCLUDED.situacao, domain=EXCLUDED.domain, domain_origin=EXCLUDED.domain_origin,
         uf_junta=EXCLUDED.uf_junta, ano_posse=EXCLUDED.ano_posse, credenciamento=EXCLUDED.credenciamento,
         associado=EXCLUDED.associado, nivel=EXCLUDED.nivel, dominio_leilao=EXCLUDED.dominio_leilao,
         collected_at=now()`,
      [String(l.id), l.nome ?? '', l.matricula ?? null, l.juntaSigla ?? null, uf, l.situacao ?? null,
        domain, declarado ? 'declarado' : doEmail ? 'email' : null,
        l.anoPosse ?? null, l.credenciamento ?? null, l.isAssociado ?? null, l.nivel ?? null, domLeilao],
    );

    // Só leiloeiro regular vira candidato a fonte.
    if (!/regular/i.test(String(l.situacao ?? ''))) continue;
    for (const d of [domain, domLeilao].filter(Boolean) as string[]) {
      const cur = sites.get(d) ?? { ufs: new Set<string>(), n: 0 };
      cur.n++;
      if (uf) cur.ufs.add(uf);
      sites.set(d, cur);
    }
  }

  for (const [domain, info] of sites) {
    await query(
      `INSERT INTO discovered_sites (domain, auctioneers, ufs) VALUES ($1,$2,$3)
       ON CONFLICT (domain) DO UPDATE SET auctioneers=EXCLUDED.auctioneers, ufs=EXCLUDED.ufs`,
      [domain, info.n, [...info.ufs]],
    );
  }

  const [{ total }] = await query<any>(`SELECT count(*)::int AS total FROM discovered_sites`);
  const [{ pendentes }] = await query<any>(
    `SELECT count(*)::int AS pendentes FROM discovered_sites WHERE checked_at IS NULL`,
  );
  return { leiloeiros: todos.length, comLeilaoBr, sitesNoCatalogo: total, aSondar: pendentes };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Redirect via interceptor: nesta versão do undici `request` não aceita maxRedirections.
const agente = new Agent({ connect: { rejectUnauthorized: false } }).compose(
  interceptors.redirect({ maxRedirections: 4 }),
);

const PLATAFORMAS: Array<[string, RegExp]> = [
  ['soleon', /soleon|d1mdxpzu4pgcoh\.cloudfront\.net|plataformasoleon/i],
  ['suporte-leiloes', /suporteleiloes|\.leilao\.br/i],
  ['superbid', /superbid|sbwebservices|s4bdigital/i],
  ['leiloesbr', /leiloesbr\.com\.br/i],
  ['leilotech', /leilotech/i],
  ['vip-leiloes', /vipleiloes/i],
  ['sua-plataforma', /suaplataformadeleilao/i],
  ['leilao-pro', /leilao\.pro|ileiloes/i],
  // vlance é o MESMO contrato do leiloesjudiciais (POST /core/api/get-lotes):
  // um conector serve os ~30 tenants.
  ['vlance', /\/v3\/js\/vlance|leiloesjudiciais|vlance\//i],
  ['leiloar', /plataformaleiloar|\/externo\/min-js/i],
  ['bomvalor', /bomvalor\.com\.br/i],
  ['sishp', /\/sishp\//i],
];
const SINAL_LOTE = /(lance\s+(inicial|atual|m[ií]nimo)|aberto\s+para\s+lances|lote\s*\d|encerra\s+em|pr[oó]ximos\s+leil[õo]es|dou-lhe)/i;

async function pega(url: string, timeout = 12000) {
  const res = await request(url, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'pt-BR,pt;q=0.9' },
    headersTimeout: timeout,
    bodyTimeout: timeout,
    dispatcher: agente,
  });
  return { status: res.statusCode, body: await res.body.text() };
}

async function sondar(domain: string) {
  const controlePath = '/__nao-existe-radar-' + Date.now();
  for (const esquema of ['https', 'http'] as const) {
    try {
      const home = await pega(`${esquema}://${domain}/`);
      let controle: { status: number; body: string } | null = null;
      try {
        controle = await pega(`${esquema}://${domain}${controlePath}`, 8000);
      } catch {
        /* controle falhar é bom sinal: o servidor discrimina */
      }
      // Servidor que devolve o mesmo para tudo não permite concluir nada.
      const indiscriminado =
        controle !== null &&
        controle.status === home.status &&
        Math.abs(controle.body.length - home.body.length) < 200;

      return {
        status: home.status,
        hasLots: indiscriminado ? null : SINAL_LOTE.test(home.body),
        platform: PLATAFORMAS.find(([, re]) => re.test(home.body))?.[0] ?? null,
        title: home.body.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim() ?? null,
        note: indiscriminado ? 'responde igual para qualquer caminho' : null,
      };
    } catch (err: any) {
      if (esquema === 'http') {
        return { status: 0, hasLots: null, platform: null, title: null, note: String(err?.code ?? err?.message ?? 'erro').slice(0, 60) };
      }
    }
  }
  return { status: 0, hasLots: null, platform: null, title: null, note: 'inalcançável' };
}

export interface ResultadoSonda {
  sondados: number;
  noAr: number;
  comPlataforma: number;
  mudaramDePlataforma: string[];
}

/**
 * Nunca sondado primeiro, depois o mais antigo. É isso que transforma a sonda
 * de mutirão único em rotina: cada passada pega a fatia mais velha do catálogo.
 */
export async function sondarSites(limite = 150, concorrencia = 12): Promise<ResultadoSonda> {
  const alvos = await query<{ domain: string; platform: string | null }>(
    `SELECT domain, platform FROM discovered_sites
      ORDER BY checked_at ASC NULLS FIRST, auctioneers DESC LIMIT $1`,
    [limite],
  );
  const antes = new Map(alvos.map((a) => [a.domain, a.platform]));
  const mudaram: string[] = [];
  let noAr = 0;
  let comPlataforma = 0;

  const fila = [...alvos];
  await Promise.all(
    Array.from({ length: concorrencia }, async () => {
      while (fila.length) {
        const alvo = fila.shift();
        if (!alvo) break;
        const r = await sondar(alvo.domain);
        await query(
          `UPDATE discovered_sites SET http_status=$2, has_lots=$3, platform=$4, title=$5, note=$6, checked_at=now()
            WHERE domain=$1`,
          [alvo.domain, r.status, r.hasLots, r.platform, r.title, r.note],
        );
        if (r.status === 200) noAr++;
        if (r.platform) comPlataforma++;
        const anterior = antes.get(alvo.domain) ?? null;
        if (anterior !== r.platform) mudaram.push(`${alvo.domain}: ${anterior ?? '—'} → ${r.platform ?? '—'}`);
      }
    }),
  );

  return { sondados: alvos.length, noAr, comPlataforma, mudaramDePlataforma: mudaram };
}

/** Registra em collection_runs para a tela de cobertura enxergar a descoberta. */
export async function rodarDescoberta(qual: 'fenaju' | 'sonda', limite?: number) {
  const runId = await startRun(qual === 'fenaju' ? 'fenaju' : 'sonda-sites', 'discover');
  try {
    if (qual === 'fenaju') {
      const r = await descobrirFenaju();
      await finishRun(runId, { ok: true, fetched: r.leiloeiros, upserted: r.sitesNoCatalogo, skipped: r.aSondar });
      return r;
    }
    const r = await sondarSites(limite);
    await finishRun(runId, { ok: true, fetched: r.sondados, upserted: r.comPlataforma, skipped: r.sondados - r.noAr });
    return r;
  } catch (err: any) {
    await finishRun(runId, { ok: false, error: String(err?.message ?? err) });
    throw err;
  }
}
