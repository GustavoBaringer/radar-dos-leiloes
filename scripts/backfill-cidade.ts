/**
 * Preenche city_key nos lotes já gravados, para o filtro de cidade não nascer
 * dividido entre "Curitiba" e "CURITIBA".
 */
import { pool, query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');
const linhas = await query<{ id: number; city: string }>(
  `SELECT id, city FROM lots WHERE city IS NOT NULL AND city <> '' AND city_key IS NULL`,
);

const porChave = new Map<string, number[]>();
for (const l of linhas) {
  const k = chaveCidade(l.city);
  if (!k) continue;
  if (!porChave.has(k)) porChave.set(k, []);
  porChave.get(k)!.push(l.id);
}
console.log(`${linhas.length} lotes com cidade, ${porChave.size} chaves distintas${aplicar ? '' : ' (simulação; use --aplicar)'}`);

if (aplicar) {
  for (const [chave, ids] of porChave) {
    await query('UPDATE lots SET city_key = $1 WHERE id = ANY($2)', [chave, ids]);
  }
  console.log('gravado');
}
await pool.end();
