/**
 * Tarefa 1 — descoberta de fontes pela FENALEI.
 *
 * A FENALEI expõe /api/public/leiloeiros sem autenticação, com 1.939 leiloeiros
 * de 28 juntas. É o único cadastro nacional que existe: o DREI não mantém um, e
 * cada junta publica a sua lista em formato próprio.
 *
 * Duas decisões:
 *  - Só `nome`, `matricula`, `junta`, `situacao` e `dominio` são gravados.
 *    E-mail, telefone e endereço são dado pessoal do leiloeiro e não servem
 *    para achar lote; o e-mail é usado em memória, só para extrair o domínio.
 *  - O campo `dominio` tem lixo (traz e-mail em alguns registros), então passa
 *    por validação de host antes de entrar.
 */
import { pool, query } from '../src/core/db.js';
import { fetchJson } from '../src/connectors/http.js';

const BASE = 'https://fenalei.org.br/api/public';
const GRATUITOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.br', 'yahoo.com', 'bol.com.br',
  'uol.com.br', 'terra.com.br', 'ig.com.br', 'live.com', 'icloud.com', 'globo.com', 'me.com',
]);

function normalizaHost(v?: string | null): string | null {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || s.includes('@')) return null;                 // e-mail no campo de site
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  if (s.split('.').length < 2) return null;
  return s;
}

function hostDoEmail(email?: string | null): string | null {
  const m = String(email ?? '').trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  const host = m[1].replace(/^www\./, '');
  return GRATUITOS.has(host) ? null : host;
}

async function paginar(path: string): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data } = await fetchJson<any>(`${BASE}/${path}?page=${page}&limit=20`, { gapMs: 350 });
    const itens: any[] = data?.data ?? [];
    out.push(...itens);
    totalPages = Number(data?.totalPages ?? 1);
    if (!itens.length) break;
    page++;
  } while (page <= totalPages);
  return out;
}

const leiloeiros = await paginar('leiloeiros');
console.log(`FENALEI: ${leiloeiros.length} leiloeiros`);

// Blocklist de sites falsos: filtro negativo que a própria federação mantém.
let bloqueados = new Set<string>();
try {
  const den = await paginar('denuncias');
  bloqueados = new Set(den.map((d: any) => normalizaHost(d.dominio ?? d.site ?? d.url)).filter(Boolean) as string[]);
  console.log(`blocklist: ${bloqueados.size} domínios denunciados`);
} catch (err: any) {
  console.warn('blocklist indisponível:', err?.message);
}

const porDominio = new Map<string, { ufs: Set<string>; n: number }>();
let comDeclarado = 0;
let porEmail = 0;

for (const l of leiloeiros) {
  const declarado = normalizaHost(l.dominio);
  const doEmail = declarado ? null : hostDoEmail(l.email);
  const domain = declarado ?? doEmail;
  const origem = declarado ? 'declarado' : doEmail ? 'email' : null;
  if (declarado) comDeclarado++;
  else if (doEmail) porEmail++;

  const uf = String(l.juntaSigla ?? '').replace(/^JUCE?/i, '').slice(0, 2).toUpperCase() || null;

  await query(
    `INSERT INTO auctioneers (registry, external_id, name, matricula, junta, uf, situacao, domain, domain_origin, blocked)
     VALUES ('fenalei',$1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (registry, external_id) DO UPDATE SET
       name=EXCLUDED.name, matricula=EXCLUDED.matricula, junta=EXCLUDED.junta, uf=EXCLUDED.uf,
       situacao=EXCLUDED.situacao, domain=EXCLUDED.domain, domain_origin=EXCLUDED.domain_origin,
       blocked=EXCLUDED.blocked, collected_at=now()`,
    [String(l.id), l.nome ?? '', l.matricula ?? null, l.juntaSigla ?? l.juntaComercial ?? null, uf,
     l.situacao ?? null, domain, origem, domain ? bloqueados.has(domain) : false],
  );

  // Só leiloeiro regular vira candidato a fonte.
  if (domain && !bloqueados.has(domain) && /regular/i.test(String(l.situacao ?? ''))) {
    const cur = porDominio.get(domain) ?? { ufs: new Set<string>(), n: 0 };
    cur.n++;
    if (uf) cur.ufs.add(uf);
    porDominio.set(domain, cur);
  }
}

for (const [domain, info] of porDominio) {
  await query(
    `INSERT INTO discovered_sites (domain, auctioneers, ufs) VALUES ($1,$2,$3)
     ON CONFLICT (domain) DO UPDATE SET auctioneers=EXCLUDED.auctioneers, ufs=EXCLUDED.ufs`,
    [domain, info.n, [...info.ufs]],
  );
}

const [{ regulares }] = await query<any>(`SELECT count(*)::int AS regulares FROM auctioneers WHERE situacao ILIKE 'regular'`);
console.log(
  `regulares=${regulares} | domínio declarado=${comDeclarado} | derivado do e-mail=${porEmail} | sites únicos=${porDominio.size}`,
);
await pool.end();
