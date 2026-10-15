import { query } from '../../../core/db.js';
import type { LoteQuente } from '../../../domain/lots/live-bids.js';

export async function lotesQuentes(fontes: string[]): Promise<LoteQuente[]> {
  const rows = await query<any>(
    `SELECT id, source_id, external_id, lot_url, raw->>'leilaoId' AS leilao_id, current_bid, auction_end_utc
       FROM lots
      WHERE source_id = ANY($1)
        AND status IN ('aberto','agendado')
        AND auction_end_utc BETWEEN now() - interval '3 minutes' AND now() + interval '60 minutes'`,
    [fontes],
  );
  return rows.map((r) => ({ id: Number(r.id), sourceId: r.source_id, externalId: String(r.external_id), lotUrl: r.lot_url, leilaoId: r.leilao_id, currentBid: r.current_bid == null ? null : Number(r.current_bid), fim: new Date(r.auction_end_utc) }));
}
