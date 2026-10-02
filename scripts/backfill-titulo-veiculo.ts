/**
 * Refaz marca, modelo, versão, anos e título exibido dos veículos já gravados,
 * com a regra da gravação atual (marcaCanonica + completaVeiculo). Recoletar a
 * bomvalor inteira passa de meia hora; isto recalcula do próprio banco.
 * Uso: tsx scripts/backfill-titulo-veiculo.ts [--fonte=bomvalor] [--aplicar]
 */
import { pool, query } from '../src/core/db.js';
import { buildSearchText, completaVeiculo, marcaCanonica, tituloDeVeiculoLimpo } from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

const aplicar = process.argv.includes('--aplicar');
const fonte = process.argv.find((a) => a.startsWith('--fonte='))?.split('=')[1] ?? null;

type Linha = {
  id: number; title_raw: string; title_display: string | null; brand: string | null; model: string | null;
  version: string | null; year_make: number | null; year_model: number | null; vehicle_type: string | null;
  city: string | null; state: string | null; seller_name: string | null;
};
const linhas = await query<Linha>(
  `SELECT id, title_raw, title_display, brand, model, version, year_make, year_model, vehicle_type, city, state, seller_name
     FROM lots WHERE asset_type = 'veiculo' ${fonte ? 'AND source_id = $1' : ''}`,
  fonte ? [fonte] : [],
);

let mudam = 0;
const exemplos: string[] = [];
for (const l of linhas) {
  const brand = marcaCanonica(l.brand, l.title_raw, l.vehicle_type);
  const modeloFonte = (l.model ?? '').trim() || null;
  const extra = modeloFonte ? null : completaVeiculo(l.title_raw, brand, l.vehicle_type);
  const model = modeloFonte ?? extra?.model ?? null;
  const version = modeloFonte ? l.version : (l.version || extra?.version || null);
  const yearMake = l.year_make ?? campos.ano(extra?.yearMake);
  const yearModel = l.year_model ?? campos.ano(extra?.yearModel);
  const titulo = campos.tituloVeiculo({ brand, model, version, yearMake, yearModel, titleRaw: tituloDeVeiculoLimpo(l.title_raw) });
  if (titulo === l.title_display && brand === l.brand && model === l.model) continue;
  mudam++;
  if (exemplos.length < 25) exemplos.push(`${l.id}: "${l.title_display}" -> "${titulo}"`);
  if (aplicar) {
    await query(
      `UPDATE lots SET brand=$1, model=$2, version=$3, year_make=$4, year_model=$5, title_display=$6, search_text=$7 WHERE id=$8`,
      [brand, model, version, yearMake, yearModel, titulo,
        buildSearchText([l.title_raw, brand, model, version, l.city, l.state, l.seller_name]), l.id],
    );
  }
}
console.log(exemplos.join('\n'));
console.log(`\n${linhas.length} veículos${fonte ? ` (${fonte})` : ''}; ${mudam} mudam${aplicar ? ' (gravados)' : ' (simulação: --aplicar grava)'}`);
await pool.end();
process.exit(0);
