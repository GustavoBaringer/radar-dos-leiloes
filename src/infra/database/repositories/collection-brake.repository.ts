import { query } from '../query.js';
import { FALHAS_PARA_FREAR, type Tentativa } from '../../../domain/collection/collection-brake.js';

export async function tentativasRecentes(sourceId: string): Promise<Tentativa[]> {
  const rows = await query<{ ok: boolean | null; started_at: Date }>(`SELECT ok, started_at FROM collection_runs
    WHERE source_id = $1 AND job IN ('collect','collect:cli') ORDER BY started_at DESC LIMIT $2`, [sourceId, FALHAS_PARA_FREAR * 4]);
  return rows.map(row => ({ ok: row.ok, startedAt: new Date(row.started_at) }));
}

export async function fontesComHistorico(): Promise<string[]> {
  const rows = await query<{ source_id: string }>("SELECT DISTINCT source_id FROM collection_runs WHERE job IN ('collect','collect:cli')");
  return rows.map(row => row.source_id);
}
