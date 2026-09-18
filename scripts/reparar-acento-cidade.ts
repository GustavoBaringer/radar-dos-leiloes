/**
 * Recupera o acento da cidade a partir do `title_display`.
 *
 * Por que é necessário: um alinhamento de grafia que eu rodei em 18/09 usou a
 * regra de desempate do `facetCidade`, que contava acento com
 * `length(city) - length(translate(...))`. translate troca um caractere por
 * outro, então a diferença era SEMPRE zero e o desempate caía na ordem
 * alfabética, onde "Sao Paulo" vence "São Paulo". O upsert repara isso na
 * próxima coleta de cada fonte — mas a Caixa está bloqueada por antibot
 * (HTTP 302) e a última coleta dela é anterior ao estrago.
 *
 * O `title_display` foi escrito ANTES e não foi tocado pelo alinhamento, então
 * ele ainda carrega a grafia original: "Apartamento 122 m² em Mooca, São Paulo/SP".
 *
 * Só restaura quando a CHAVE é a mesma — garante que é a mesma cidade, só com
 * grafia melhor. Nunca inventa cidade nova.
 *
 * Sem argumento simula. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');

type Linha = { id: number; source_id: string; city: string; title_display: string | null };

const linhas = await query<Linha>(
  `SELECT id, source_id, city, title_display FROM lots
    WHERE city IS NOT NULL AND title_display IS NOT NULL
      AND city !~ '[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]'
      AND title_display ~ '[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]'`,
);

/** "Apartamento 122 m² em Mooca, São Paulo/SP" -> "São Paulo" */
function cidadeDoTitulo(t: string): string | null {
  const m = t.match(/,\s*([^,\/]+)\/[A-Z]{2}\s*$/);
  return m ? m[1].trim() : null;
}

const mudancas: Array<{ l: Linha; nova: string }> = [];
for (const l of linhas) {
  const doTitulo = cidadeDoTitulo(l.title_display!);
  if (!doTitulo) continue;
  // A chave TEM de bater: garante mesma cidade, só grafia diferente.
  if (chaveCidade(doTitulo) !== chaveCidade(l.city)) continue;
  // E a do título precisa ser melhor, não só diferente.
  if (!/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(doTitulo)) continue;
  mudancas.push({ l, nova: doTitulo });
}

const porCaso = new Map<string, number>();
for (const m of mudancas) porCaso.set(`${m.l.source_id}: ${m.l.city} -> ${m.nova}`, (porCaso.get(`${m.l.source_id}: ${m.l.city} -> ${m.nova}`) ?? 0) + 1);
console.log(`${linhas.length} candidatos | ${mudancas.length} recuperam o acento\n`);
for (const [k, n] of [...porCaso].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(n).padStart(5)}  ${k}`);

if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  await pool.end();
  process.exit(0);
}
for (const m of mudancas) await query(`UPDATE lots SET city=$1 WHERE id=$2`, [m.nova, m.l.id]);
console.log(`\n${mudancas.length} lotes recuperados.`);
await pool.end();
process.exit(0);
