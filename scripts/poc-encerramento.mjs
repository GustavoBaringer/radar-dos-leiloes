/**
 * POC: verificar lote a lote no site da origem vale a pena?
 *
 * A pergunta que isto decide não é "dá para fazer" — é se a verificação
 * individual sabe algo que a varredura de catálogo já não saiba, e a que custo
 * real. Duas coisas que só medindo dá para responder:
 *
 *  1. Os lotes que a fonte PAROU de devolver (que a regra de ausência fecharia)
 *     estão mesmo encerrados? Se estiverem abertos, a regra fecharia lote vivo.
 *  2. Os lotes que a fonte AINDA devolve como abertos estão mesmo abertos?
 *     Se não, a listagem mente e a varredura sozinha não basta.
 *
 * Cadência: 1 req/s POR HOST, hosts em paralelo — a mesma regra da coleta.
 */
import { execSync } from 'node:child_process';

const POR_GRUPO = Number(process.argv[2] ?? 12);
const SEP = '|@|';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const sql = (q) =>
  execSync(`docker exec -i leilao-db psql -U leilao -d leilao -t -A -F'${SEP}'`, {
    input: q, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim().split('\n').filter(Boolean).map((l) => l.split(SEP));

/**
 * Amostra estratificada: para cada fonte, lotes VISTOS e NÃO VISTOS na última
 * varredura completa. Comparar só um dos grupos não responde nada — é a
 * diferença entre eles que diz se a ausência na listagem é sinal de encerramento.
 */
const linhas = sql(`
  WITH ult AS (
    SELECT source_id, max(started_at) u FROM collection_runs
     WHERE job IN ('collect','collect:cli') AND ok GROUP BY 1),
  cand AS (
    SELECT l.id, l.source_id, l.lot_url,
           CASE WHEN l.collected_at >= ult.u THEN 'visto' ELSE 'ausente' END AS grupo,
           row_number() OVER (PARTITION BY l.source_id,
                              CASE WHEN l.collected_at >= ult.u THEN 'visto' ELSE 'ausente' END
                              ORDER BY random()) AS n
      FROM lots l JOIN ult ON ult.source_id = l.source_id
     WHERE l.status IN ('aberto','agendado')
       AND l.auction_end_utc IS NULL
       AND (l.auction_start_utc IS NULL OR l.closing_model = 'timer_por_lote')
       AND l.lot_url IS NOT NULL)
  SELECT id, source_id, grupo, lot_url FROM cand WHERE n <= ${POR_GRUPO} ORDER BY source_id, grupo`);

const amostra = linhas.map(([id, source, grupo, url]) => ({ id, source, grupo, url }));
const host = (u) => { try { return new URL(u).host; } catch { return '?'; } };

console.log(`amostra: ${amostra.length} lotes`);
for (const s of [...new Set(amostra.map((a) => a.source))]) {
  const seg = amostra.filter((a) => a.source === s);
  console.log(`  ${s}: ${seg.filter((x) => x.grupo === 'visto').length} vistos · ${seg.filter((x) => x.grupo === 'ausente').length} ausentes · ${new Set(seg.map((x) => host(x.url))).size} hosts`);
}

/** O que a página diz. Cada fonte tem um marcador diferente — e uma delas não tem nenhum. */
function classificar(source, http, corpo, urlFinal) {
  if (http === 404 || http === 410) return { veredito: 'sumiu', sinal: `HTTP ${http}` };
  if (http !== 200) return { veredito: 'indeterminado', sinal: http ? `HTTP ${http}` : 'sem resposta' };

  if (source === 'soleon') {
    const m = /id="status_lote"[\s\S]{0,400}?class="label_lote ([a-z_]+)"[^>]*>([^<]*)</i.exec(corpo);
    if (!m) return { veredito: 'indeterminado', sinal: 'sem #status_lote na página' };
    const classe = m[1].toLowerCase();
    const texto = m[2].trim();
    if (/aberto/.test(classe)) return { veredito: 'aberto', sinal: texto };
    if (/aguard/.test(classe)) return { veredito: 'agendado', sinal: texto };
    if (/encerrad|sustad|arrematad|vendid|cancelad|suspens|deserto|retirad/.test(classe)) {
      return { veredito: 'encerrado', sinal: texto };
    }
    return { veredito: 'indeterminado', sinal: `${classe} / ${texto}` };
  }

  if (source === 'vlance') {
    // Redirecionar para a home é o sintoma já conhecido deste provedor quando o
    // lote não existe mais.
    if (urlFinal && new URL(urlFinal).pathname.replace(/\/+$/, '') === '') {
      return { veredito: 'sumiu', sinal: 'redirecionou para a home' };
    }
    const t = corpo.replace(/\s+/g, ' ');
    if (/encerrad|arrematad|lote vendido|leil[ãa]o encerrado/i.test(t)) return { veredito: 'encerrado', sinal: 'texto de encerramento' };
    if (/dar lance|efetuar lance|lance atual/i.test(t)) return { veredito: 'aberto', sinal: 'texto de lance ativo' };
    return { veredito: 'indeterminado', sinal: 'sem marcador' };
  }

  // leilo é SPA: responde 200 e desenha o conteúdo no cliente, inclusive o 404.
  // O HTML cru não carrega status nenhum — e é esse o achado, não uma limitação
  // desta POC.
  return { veredito: 'indeterminado', sinal: 'SPA: HTML sem status' };
}

async function buscar(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const corpo = await r.text();
    return { http: r.status, corpo, urlFinal: r.url, ms: Date.now() - t0 };
  } catch (e) {
    return { http: 0, corpo: '', urlFinal: null, ms: Date.now() - t0, erro: String(e.message).slice(0, 60) };
  }
}

const porHost = new Map();
for (const a of amostra) porHost.set(host(a.url), [...(porHost.get(host(a.url)) ?? []), a]);
console.log(`\nbuscando em ${porHost.size} hosts, 1 req/s dentro de cada...`);
const t0 = Date.now();

const resultados = (await Promise.all([...porHost.values()].map(async (lotes) => {
  const saida = [];
  for (let i = 0; i < lotes.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    const a = lotes[i];
    const r = await buscar(a.url);
    saida.push({ ...a, ...r, ...classificar(a.source, r.http, r.corpo, r.urlFinal) });
  }
  return saida;
}))).flat();

const decorrido = ((Date.now() - t0) / 1000).toFixed(0);
const lat = resultados.map((r) => r.ms).sort((a, b) => a - b);
const p = (q) => lat[Math.floor(lat.length * q)] ?? 0;

console.log(`\n=== RESULTADO (${decorrido}s de parede) ===\n`);
for (const s of [...new Set(resultados.map((r) => r.source))]) {
  console.log(`${s}:`);
  for (const g of ['visto', 'ausente']) {
    const seg = resultados.filter((r) => r.source === s && r.grupo === g);
    if (!seg.length) continue;
    const cont = {};
    for (const r of seg) cont[r.veredito] = (cont[r.veredito] ?? 0) + 1;
    const desc = Object.entries(cont).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
    console.log(`  ${g.padEnd(8)} (${String(seg.length).padStart(2)}): ${desc}`);
    for (const r of seg.slice(0, 2)) console.log(`      ex. lote ${r.id}: HTTP ${r.http} - ${r.veredito} - "${r.sinal}"`);
  }
}
console.log(`\nlatencia por requisicao: p50 ${p(0.5)}ms - p90 ${p(0.9)}ms - max ${lat.at(-1)}ms`);
// O veredito da POC: entre os que a regra de ausência fecharia, quantos estão
// de fato encerrados e quantos seriam mortos vivos.
for (const s of [...new Set(resultados.map((r) => r.source))]) {
  const aus = resultados.filter((r) => r.source === s && r.grupo === 'ausente');
  if (!aus.length) continue;
  const mortos = aus.filter((r) => r.veredito === 'encerrado' || r.veredito === 'sumiu').length;
  const vivos = aus.filter((r) => r.veredito === 'aberto' || r.veredito === 'agendado').length;
  const cego = aus.filter((r) => r.veredito === 'indeterminado').length;
  console.log(`\n[${s}] regra de ausencia fecharia ${aus.length}: ${mortos} corretos, ` +
    `${vivos} VIVOS (fechados por engano), ${cego} sem como saber pelo HTML`);
}
