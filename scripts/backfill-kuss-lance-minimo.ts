/** Preenche lances mínimos ausentes da Kuss pelo id estável da fonte.
 * Simulação por padrão. --aplicar grava em transação após consultar todos os lotes.
 * --backup=/caminho/arquivo.json salva os valores anteriores antes da gravação.
 */
import { writeFile } from 'node:fs/promises';
import { pool, query } from '../src/core/db.js';
import { isBidSuspect } from '../src/core/repo.js';
import { buscarLanceMinimoKuss } from '../src/connectors/kuss.js';

interface Lot {
  id: number;
  leilao: string;
  le_id: string;
  min_bid: number | null;
  current_bid: number | null;
  appraisal: number | null;
  bid_suspect: boolean;
}
const aplicar = process.argv.includes('--aplicar');
const backup = process.argv.find((arg) => arg.startsWith('--backup='))?.slice('--backup='.length);
if (aplicar && !backup) throw new Error('--aplicar exige --backup=/caminho/arquivo.json');

try {
  const rows = await query<Lot>(`SELECT id, raw->>'leilaoId' AS leilao, raw->>'leId' AS le_id,
    min_bid, current_bid, appraisal, bid_suspect FROM lots
    WHERE source_id = 'kuss' AND min_bid IS NULL ORDER BY id`);
  const plan: Array<{ before: Lot; minBid: number; bidSuspect: boolean }> = [];
  let semValor = 0;
  let semIdentidade = 0;
  let lidos = 0;
  for (const row of rows) {
    if (!/^\d+$/.test(row.leilao ?? '') || !/^\d+$/.test(row.le_id ?? '')) {
      semIdentidade++;
      continue;
    }
    const minBid = await buscarLanceMinimoKuss(row.leilao, row.le_id);
    lidos++;
    if (minBid === null) semValor++;
    else plan.push({ before: row, minBid, bidSuspect: isBidSuspect(row.current_bid ?? minBid, row.appraisal) });
    if (lidos % 25 === 0) console.log(JSON.stringify({ lidos, total: rows.length, mapeados: plan.length, semValor }));
  }
  if (backup) await writeFile(backup, JSON.stringify({ createdAt: new Date().toISOString(), plan }, null, 2), { flag: 'wx', mode: 0o600 });
  let gravados = 0;
  if (aplicar) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { before, minBid, bidSuspect } of plan) {
        const result = await client.query(`UPDATE lots SET min_bid = $1, bid_suspect = $2
          WHERE id = $3 AND source_id = 'kuss' AND min_bid IS NULL
          AND raw->>'leilaoId' = $4 AND raw->>'leId' = $5
          AND current_bid IS NOT DISTINCT FROM $6::numeric
          AND appraisal IS NOT DISTINCT FROM $7::numeric`,
        [minBid, bidSuspect, before.id, before.leilao, before.le_id, before.current_bid, before.appraisal]);
        gravados += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(JSON.stringify({ modo: aplicar ? 'aplicado' : 'simulacao', total: rows.length,
    lidos, mapeados: plan.length, gravados, semValor, semIdentidade, concorrentes: aplicar ? plan.length - gravados : 0 }));
} finally {
  await pool.end();
}
