/**
 * Classifica o tipo dos imóveis já gravados. A classificação roda na ingestão,
 * então lote antigo só ganha o campo por recoleta — e recoletar 8 mil imóveis
 * da Caixa custa uma requisição contra um antibot que bloqueia por IP.
 * Reclassificar a partir do que já está no banco é mais barato e igualmente
 * correto: a entrada do classificador é `source_category` e `title_raw`, que
 * já estão gravados.
 */
import { pool, query } from '../src/core/db.js';
import { classifyProperty } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');
const linhas = await query<{ id: number; title_raw: string; source_category: string | null }>(
  `SELECT id, title_raw, source_category FROM lots WHERE asset_type = 'imovel'`,
);

const porTipo = new Map<string, number>();
const lotes: [string, number[]][] = [];
const pendentes = new Map<string, number[]>();
for (const l of linhas) {
  const tipo = classifyProperty(l.title_raw, l.source_category) ?? 'outro';
  porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + 1);
  if (!pendentes.has(tipo)) pendentes.set(tipo, []);
  pendentes.get(tipo)!.push(l.id);
}
for (const [tipo, ids] of pendentes) lotes.push([tipo, ids]);

for (const [tipo, n] of [...porTipo].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tipo.padEnd(12)} ${String(n).padStart(5)}`);
}
console.log(`\n${linhas.length} imóveis classificados${aplicar ? '' : ' (simulação; use --aplicar)'}`);

if (aplicar) {
  for (const [tipo, ids] of lotes) {
    await query('UPDATE lots SET property_type = $1 WHERE id = ANY($2)', [tipo, ids]);
  }
  console.log('gravado');
}
await pool.end();
