/**
 * Refaz a marca dos veículos já gravados com a regra de gravação atual
 * (marcaCanonica): variante crua da fonte vira a canônica, e marca vazia sai
 * do título. Sem isto, "M.BENZ", "GMC" e "MERCEDES" seguiam fora da busca por
 * marca até a próxima coleta de cada fonte. Simula por padrão; --aplicar grava.
 */
import { pool, query } from '../src/core/db.js';
import { buildSearchText, marcaCanonica } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');

type Linha = {
  id: number; title_raw: string; brand: string | null; model: string | null; version: string | null; vehicle_type: string | null;
  city: string | null; state: string | null; seller_name: string | null;
};
const linhas = await query<Linha>(
  `SELECT id, title_raw, brand, model, version, vehicle_type, city, state, seller_name FROM lots WHERE asset_type = 'veiculo'`,
);

const transicoes = new Map<string, number>();
const mudancas: Array<{ id: number; brand: string | null; searchText: string }> = [];
for (const l of linhas) {
  const nova = marcaCanonica(l.brand, l.title_raw, l.vehicle_type);
  if (nova === l.brand) continue;
  const chave = `${l.brand === null ? '(nula)' : l.brand === '' ? '(vazia)' : l.brand} -> ${nova ?? '(nula)'}`;
  transicoes.set(chave, (transicoes.get(chave) ?? 0) + 1);
  mudancas.push({
    id: l.id,
    brand: nova,
    searchText: buildSearchText([l.title_raw, nova, l.model, l.version, l.city, l.state, l.seller_name]),
  });
}

for (const [k, n] of [...transicoes].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
console.log(`\n${linhas.length} veículos; ${mudancas.length} mudam de marca${aplicar ? '' : ' (simulação: rode com --aplicar para gravar)'}`);

if (aplicar && mudancas.length) {
  for (const m of mudancas) await query('UPDATE lots SET brand = $1, search_text = $2 WHERE id = $3', [m.brand, m.searchText, m.id]);
  console.log(`${mudancas.length} lotes atualizados`);
}
await pool.end();
process.exit(0);
