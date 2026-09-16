/**
 * Rescrub retroativo. O scrub roda na ingestão, então lote já gravado antes de
 * um padrão novo continua em claro no banco — corrigir a regex não limpa o
 * passado. Este script reaplica o scrub atual sobre o que já está gravado.
 */
import { pool, query } from '../src/core/db.js';
import { scrubPlates } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');

const suspeitos = await query<{ id: number; source_id: string; title_raw: string; plate_masked: string | null }>(
  `SELECT id, source_id, title_raw, plate_masked FROM lots
    WHERE title_raw ~* '(chassi|renava[nm]|motor)\\s*n?[ºo°.]?\\s*:?\\s*[A-Z0-9]{6,}'
       OR title_raw ~* 'placas?\\s*n?[ºo°.]?\\s*:?\\s*[A-Z]{2,3}[\\s-]?[0-9A-Z]{3,4}'
    LIMIT 2000`,
);

let mudados = 0;
for (const l of suspeitos) {
  const { text, plateMasked } = scrubPlates(l.title_raw);
  if (text === l.title_raw) continue;
  mudados++;
  console.log(`${l.id} ${l.source_id}\n  antes : ${l.title_raw.slice(0, 150)}\n  depois: ${text.slice(0, 150)}`);
  if (aplicar) {
    await query('UPDATE lots SET title_raw = $1, plate_masked = COALESCE(plate_masked, $2) WHERE id = $3', [
      text,
      plateMasked,
      l.id,
    ]);
  }
}
console.log(`\n${suspeitos.length} candidatos, ${mudados} com identificador em claro${aplicar ? ' — ATUALIZADOS' : ' (simulação; use --aplicar)'}`);
await pool.end();
