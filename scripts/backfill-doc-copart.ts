/**
 * Refaz a situação do bem dos lotes Copart gravados como "conservado".
 *
 * O conector tratava o documento NORMAL como estado físico, e lote capotado
 * aparecia como Conservado. Todo "conservado" da Copart nasceu de documento
 * NORMAL ou NÃO APLICÁVEL, e o dano físico da fonte já está em raw.damage: dá
 * para recalcular sem recoletar. Simula por padrão; --aplicar grava.
 */
import { pool, query } from '../src/core/db.js';
import * as campos from '../src/core/campos.js';
import { docCopart } from '../src/connectors/copart.js';

const aplicar = process.argv.includes('--aplicar');

const linhas = await query<{ id: number; dano: string | null }>(
  `SELECT id, raw->>'damage' AS dano FROM lots WHERE source_id = 'copart' AND doc_type = 'conservado'`,
);

const contagem = new Map<string, number>();
const mudancas: Array<{ id: number; novo: string | null }> = [];
for (const l of linhas) {
  const novo = campos.docType(docCopart('NORMAL', null, l.dano));
  const chave = `${l.dano ?? '(vazio)'} -> ${novo ?? 'sem rótulo'}`;
  contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
  if (novo !== 'conservado') mudancas.push({ id: l.id, novo });
}

for (const [k, n] of [...contagem].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
console.log(`\n${linhas.length} lotes conservado; ${mudancas.length} mudam${aplicar ? '' : ' (simulação: rode com --aplicar para gravar)'}`);

if (aplicar && mudancas.length) {
  for (const m of mudancas) await query('UPDATE lots SET doc_type = $1 WHERE id = $2', [m.novo, m.id]);
  console.log(`${mudancas.length} lotes atualizados`);
}
await pool.end();
process.exit(0);
