/** Pure discovery rules: no I/O or framework dependencies. */
const GRATUITOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.br', 'yahoo.com', 'bol.com.br',
  'uol.com.br', 'terra.com.br', 'ig.com.br', 'live.com', 'icloud.com', 'globo.com', 'me.com',
]);
export function host(v?: string | null): string | null {
  if (!v) return null;
  // Primeiro token: o resto costuma ser rótulo humano ("E-mail: ...", "Tel: ...").
  let s = String(v).trim().toLowerCase().split(/[\s\n\r]+/)[0];
  if (!s) return null;
  s = s
    .replace(/&nbsp;|&amp;/g, '')
    // esquema repetido: 'http://http://'
    .replace(/^(?:https?:\/\/)+/, '')
    // ponto solto logo depois do esquema
    .replace(/^\.+/, '');
  // Dois domínios no mesmo campo: fica o primeiro, que a fonte trata como principal.
  s = s.split(/[,;]/)[0];
  if (!s || s.includes('@')) return null;
  s = s
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    // lixo de HTML que sobra quando o valor foi copiado de dentro de um atributo
    .replace(/["'>»<]+$/g, '')
    .replace(/\.+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

export function hostDoEmail(email?: string | null): string | null {
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

export interface ResultadoSonda {
  sondados: number;
  noAr: number;
  comPlataforma: number;
  mudaramDePlataforma: string[];
}

export function requirePersistedFenaju<T>(row: T | undefined, externalId: string): T {
  if (!row) throw new Error(`Upsert FENAJU recusado para external_id=${externalId}; registro reconciliado divergente.`);
  return row;
}

export function acumulaSiteFenaju(sites: Map<string, { ufs: Set<string>; n: number }>, domain: string | null, uf: string | null) {
  if (!domain) return;
  const cur = sites.get(domain) ?? { ufs: new Set<string>(), n: 0 };
  cur.n++;
  if (uf) cur.ufs.add(uf);
  sites.set(domain, cur);
}

export const PLATAFORMAS: Array<[string, RegExp]> = [
  ['msis', /Principal\.asp|abrirDetalhesLeilao|msis\.com\.br/i],
  ['mega', /megaleiloes\.com\.br|Mega Leilões/i],
  ['grupolance', /grupolance\.com\.br|Grupo Lance/i],
  // `\bZuk\b`, não `Zuk`: sem fronteira a alternativa casava "SUZUKI" no card de
  // veículo e gravava platform=portalzuk em site da Suporte Leilões (medido em
  // rapidaovende.com.br e fernandalimaleiloes.com.br, 13/10/2026).
  ['portalzuk', /portalzuk\.com\.br|zukerman\.com\.br|frazaoleiloes\.com\.br|lut\.com\.br|\bZuk\b/i],
  ['parquedosleiloes', /parquedosleiloes\.com\.br|Parque dos Leilões/i],
  ['lucianleiloes', /lucianleiloes\.com\.br|Lucian Leilões/i],
  ['hasta-publica', /hastapublica\.com\.br|valland\.com\.br|Valland Leilões|LoteSmall/i],
  ['flexleiloes', /flexleiloes\.com\.br|FlexLeil(?:&otilde;|õ)es|js\/leilao\.js/i],
  ['alfaleiloes', /alfaleiloes\.com|Alfa Leilões|logo-alfa-card/i],
  ['casadeleiloes', /casadeleiloes\.com\.br|Casa de Leilões|lote-lista/i],
  ['grupocarvalho', /grupocarvalholeiloes\.com\.br|Grupo Carvalho Leilões|midias-plataforma\.s3/i],
  ['simonleiloes', /simonleiloes\.com\.br|Simon Leilões|prod-simonleiloes-assets/i],
  ['globoleiloes', /globoleiloes\.com\.br|Globo Leilões|inertia-vendor/i],
  ['leiloesfreire', /leiloesfreire\.com\.br|Leilões Freire|lote_destaque_imagem/i],
  ['rochaleiloes', /rochaleiloes\.com\.br|Rocha Leilões|<home-banners/i],
  ['benedetto', /benedettoleiloes\.com\.br|Benedetto Leilões|storage\/lote/i],
  ['docx-html', /Central Sul de Leilões|centralsuldeleiloes\.com\.br|cristianoescolaleiloes\.com\.br|Leiloaria Smart|leiloariasmart\.com\.br|Lara Forster Leilões|leiloeslaraforster\.com\.br|arremate\.lel\.br|caiapoleiloes\.com\.br|norteleiloes\.com\.br|roisoft|listar-dados|LED_DIA_F/i],
  // Plataforma ASP.NET white-label: a home costuma ser institucional e só traz
  // o selo/link para leilovia.com.br; o catálogo real fica em /leiloes.aspx.
  ['leilovia', /leilovia\.com\.br|leiloes\.aspx|lote-lista/i],
  ['soleon', /soleon|d1mdxpzu4pgcoh\.cloudfront\.net|plataformasoleon/i],
  ['suporte-leiloes', /suporteleiloes|\.leilao\.br/i],
  ['superbid', /superbid|sbwebservices|s4bdigital|Superbid Exchange/i],
  ['leiloesbr', /leiloesbr\.com\.br/i],
  ['leilotech', /leilotech|cdn\.leilotech|__TENANT__|v2-seo-snapshot|ws\.leilotech/i],
  ['vip-leiloes', /vipleiloes/i],
  ['sua-plataforma', /suaplataformadeleilao/i],
  ['leilao-pro', /leilao\.pro|ileiloes/i],
  // vlance é o MESMO contrato do leiloesjudiciais (POST /core/api/get-lotes):
  // um conector serve os ~30 tenants.
  ['vlance', /\/v3\/js\/vlance|leiloesjudiciais|vlance\/|core\/api\/get-lotes/i],
  ['leiloar', /plataformaleiloar|bem-card|bens\/pesquisaAvancada|\/externo\/min-js|d1lance\.com|leiloeirodian\.com\.br|nortedeminasleiloes\.com\.br|leiloesdonorte\.com\.br/i],
  ['labasoft', /labasoft|featured-post|karlapepe\.lel\.br|leiloesbraga\.lel\.br/i],
  ['html-agenda', /\/agenda-de-leiloes|\/eventos\/proximos|\/lotes-encerrando|\/eventos\/leilao\/|\/lote\/\d+|\/leilao\/\d+|Agenda\.aspx|evento\.php/i],
  ['bomvalor', /bomvalor\.com\.br|servicos\.bomvalor/i],
  ['sishp', /\/sishp\//i],
];
const SINAL_LOTE = /(lance\s+(inicial|atual|m[ií]nimo)|aberto\s+para\s+lances|lote\s*\d|encerra\s+em|pr[oó]ximos\s+leil[õo]es|dou-lhe)/i;

const CONECTOR_POR_PLATAFORMA: Record<string, string | null> = {
  'html-agenda': 'htmlagenda',
  soleon: 'soleon',
  'suporte-leiloes': 'suporteleiloes',
  superbid: 'superbid',
  leiloesbr: 'leiloesbr',
  leilotech: 'leilotech',
  'vip-leiloes': null,
  'sua-plataforma': 'suaplataforma',
  'leilao-pro': 'leilaopro',
  vlance: 'vlance',
  leiloar: 'leiloar',
  bomvalor: 'bomvalor',
  sishp: 'sishp',
  mega: 'megaleiloes',
  grupolance: 'grupolance',
  portalzuk: 'portalzuk',
  parquedosleiloes: 'parquedosleiloes',
  lucianleiloes: 'lucianleiloes',
  // White-label sem plataforma nomeada no HTML: quem descobre na mão escreve a
  // plataforma na linha e a sonda passa a PRESERVAR (ver o COALESCE lá embaixo).
  'ares-postgrest': null,
  'hasta-publica': 'hastapublica',
  flexleiloes: 'flexleiloes',
  alfaleiloes: 'alfaleiloes',
  casadeleiloes: 'casadeleiloes',
  grupocarvalho: 'grupocarvalho',
  simonleiloes: 'simonleiloes',
  globoleiloes: 'globoleiloes',
  leiloesfreire: 'leiloesfreire',
  rochaleiloes: 'rochaleiloes',
  benedetto: 'benedetto',
  'docx-html': 'docxhtml',
  leilovia: 'leilovia',
  goadopt: null,
  msis: 'msis',
};

export function conectorDaPlataforma(
  plataformaAtual: string | null | undefined,
  plataformaDetectada: string | null | undefined,
): string | null {
  const plataforma = plataformaAtual ?? plataformaDetectada;
  return plataforma ? CONECTOR_POR_PLATAFORMA[plataforma] ?? null : null;
}

export function analisarHtmlSite(body: string, indiscriminado: boolean) {
  return {
    hasLots: indiscriminado ? null : SINAL_LOTE.test(body),
    platform: PLATAFORMAS.find(([, re]) => re.test(body))?.[0] ?? null,
    title: body.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim() ?? null,
    note: indiscriminado ? 'responde igual para qualquer caminho' : null,
  };
}
