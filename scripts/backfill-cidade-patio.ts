/**
 * Deriva cidade/UF do PÁTIO DE RETIRADA para os lotes já gravados.
 *
 * Por que não basta corrigir o conector: lote antigo só mudaria por recoleta, e
 * a Freitas tem 1.247 lotes — recoletar para arrumar texto é pagar caro por algo
 * que se recalcula do próprio banco, já que `yard` está lá.
 *
 * A regra é a mesma do conector: a cidade do lote é a do lugar onde o bem está
 * (retirada), não a do pregão. MEDIDO em 18/09: 708 lotes sem cidade e 25 com a
 * cidade do PREGÃO em vez da do pátio.
 *
 * Sem argumento simula e imprime o diff. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

const aplicar = process.argv.includes('--aplicar');

/**
 * O pátio só é fonte de cidade quando é um ENDEREÇO, nunca quando é um NOME.
 *
 * O dry-run da primeira versão deste script ia trocar "Aparecida de Goiânia" por
 * "Pátio Central" em 297 lotes e "Eusébio" por "Fortaleza" em 92 — o leilo batiza
 * o pátio com o nome da capital mais próxima, e a coluna `city` dele já está
 * correta. Ler o nome do pátio como cidade destruiria dado bom.
 *
 * O discriminador é a forma: endereço tem tipo de logradouro E número. Nome de
 * pátio não tem nenhum dos dois.
 */
const PARECE_ENDERECO = /\b(av|avenida|r|rua|rod|rodovia|estrada|praca|praça|alameda|travessa)\b\.?\s/i;
const TEM_NUMERO = /\d/;

function cidadeDoPatio(yard: string | null): { city: string; uf: string } | null {
  const texto = yard ?? '';
  if (!PARECE_ENDERECO.test(texto) || !TEM_NUMERO.test(texto)) return null;
  const seg = texto.split(/\s-\s/).pop()?.trim() ?? '';
  const m = seg.match(/^(.+?)\/([A-Za-z]{2})$/);
  if (!m) return null;
  const city = campos.caixaDeTitulo(m[1].trim());
  return city ? { city, uf: m[2].toUpperCase() } : null;
}

type Linha = { id: number; source_id: string; yard: string | null; city: string | null; state: string | null };

const linhas = await query<Linha>(
  `SELECT id, source_id, yard, city, state FROM lots
    WHERE yard IS NOT NULL AND yard ~ '/[A-Za-z]{2}$' ORDER BY id`,
);

const mudancas: Array<{ l: Linha; city: string; uf: string; motivo: 'ausente' | 'divergente' }> = [];
for (const l of linhas) {
  const p = cidadeDoPatio(l.yard);
  if (!p) continue;
  if (!l.city) mudancas.push({ l, ...p, motivo: 'ausente' });
  // Divergência é o caso mais grave: a cidade gravada aponta para outro lugar.
  else if (chaveCidade(l.city) !== chaveCidade(p.city)) mudancas.push({ l, ...p, motivo: 'divergente' });
}

const porCaso = new Map<string, number>();
for (const m of mudancas) {
  const k = `${m.l.source_id} · ${m.motivo}: ${m.l.city ?? '(nula)'} -> ${m.city}/${m.uf}`;
  porCaso.set(k, (porCaso.get(k) ?? 0) + 1);
}
console.log(`${linhas.length} lotes com pátio terminando em /UF | ${mudancas.length} mudam\n`);
for (const [k, n] of [...porCaso].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);

if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  await pool.end();
  process.exit(0);
}
for (const m of mudancas) {
  await query(`UPDATE lots SET city=$1, state=$2, city_key=$3 WHERE id=$4`, [m.city, m.uf, chaveCidade(m.city), m.l.id]);
}
console.log(`\n${mudancas.length} lotes regravados.`);

await pool.end();
process.exit(0);
