/**
 * Re-deriva marca e modelo do TÍTULO para os lotes já gravados.
 *
 * Por que não serve o backfill-normalizar: aquele recalcula a partir dos campos
 * já gravados (brand, model), então um brand errado continua errado. Aqui a
 * entrada é o título cru, que é a fonte de verdade do parser.
 *
 * Escopo deliberadamente estreito: só toca linha onde o parser ATUAL discorda
 * do gravado E o gravado não tem evidência no título. Marca que veio do
 * conector (o leilo grava `infocarMarca`, e é assim que KAWASAKI e BYD existem
 * sem estar no dicionário) não é tocada — o parser não a conhece e apagá-la
 * seria perder dado bom.
 *
 * Sem argumento simula. Com --aplicar, grava.
 */
import { readFileSync } from 'node:fs';
import { pool, query } from '../src/core/db.js';
import { fold, parseTitle } from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

const aplicar = process.argv.includes('--aplicar');

const fonte = readFileSync('src/core/normalize.ts', 'utf8');
const aliases = new Map<string, string[]>();
for (const m of fonte.matchAll(/canonical:\s*'([^']+)',\s*aliases:\s*\[([^\]]*)\]/gs)) {
  aliases.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}
const declaradas = [...fonte.matchAll(/canonical:\s*'([^']+)'/g)].length;
if (aliases.size !== declaradas) {
  console.error(`extração de aliases incompleta (${aliases.size}/${declaradas})`);
  process.exit(1);
}

/** A marca gravada tem alguma prova no título? */
function temProva(titulo: string, marca: string): boolean {
  const t = ` ${fold(titulo)} `;
  return [marca, ...(aliases.get(marca) ?? [])].some((p) => t.includes(` ${fold(p)} `));
}

type Linha = {
  id: number; title_raw: string; title_display: string | null; brand: string | null; model: string | null;
  version: string | null; year_make: number | null; year_model: number | null; vehicle_type: string | null;
};

const linhas = await query<Linha>(
  `SELECT id, title_raw, title_display, brand, model, version, year_make, year_model, vehicle_type
     FROM lots WHERE asset_type='veiculo' AND brand IS NOT NULL ORDER BY id`,
);

const mudancas: Array<{ l: Linha; brand: string | null; model: string | null; titulo: string }> = [];
for (const l of linhas) {
  // Marca com prova no título está certa, venha de onde vier.
  if (temProva(l.title_raw, l.brand!)) continue;
  const p = parseTitle(l.title_raw);
  // O parser ainda afirma a mesma marca: nada a corrigir.
  if ((p.brand ?? null) === l.brand) continue;
  // O parser não conhece a marca (veio do conector): não apagar.
  if (p.brand === null && !aliases.has(l.brand!)) continue;
  const titulo = campos.tituloVeiculo({
    brand: p.brand ?? null, model: p.model ?? null, version: p.version ?? l.version,
    yearMake: l.year_make, yearModel: l.year_model, titleRaw: l.title_raw,
  });
  mudancas.push({ l, brand: p.brand ?? null, model: p.model ?? null, titulo });
}

console.log(`${linhas.length} veículos com marca | ${mudancas.length} corrigem\n`);
for (const m of mudancas.slice(0, 20)) {
  console.log(`  [${m.l.vehicle_type}] ${m.l.brand}/${m.l.model ?? '—'} -> ${m.brand ?? '—'}/${m.model ?? '—'}`);
  console.log(`      "${m.l.title_display}" -> "${m.titulo}"`);
}
if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  await pool.end();
  process.exit(0);
}
for (const m of mudancas) {
  await query(`UPDATE lots SET brand=$1, model=$2, title_display=$3 WHERE id=$4`, [m.brand, m.model, m.titulo, m.l.id]);
}
console.log(`\n${mudancas.length} lotes regravados.`);
await pool.end();
process.exit(0);
