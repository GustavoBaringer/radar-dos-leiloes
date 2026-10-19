import { Injectable } from '@nestjs/common';
import { query } from '../query.js';
import { VENCIDO } from '../queries/lot-status.js';

export interface CandidatoVerificacao {
  id: string;
  source_id: string;
  external_id: string | null;
  lot_url: string | null;
  source_category: string | null;
}

export interface LotClosureRepositoryPort {
  encerrarPorPrazo(): Promise<number>;
  encerrarPorAusencia(ciclos: number, limite: number): Promise<number>;
  candidatos(fontes: string[], limite: number, teto: number): Promise<CandidatoVerificacao[]>;
  aplicarVereditos(mortos: Array<{ id: number; sinal: string }>, vivos: Array<{ id: number; sinal: string }>, indeterminados: Array<{ id: number; sinal: string }>): Promise<void>;
  corrigirPrazo(vereditos: Array<{ id: number; fimUtc: string }>): Promise<void>;
}

@Injectable()
export class LotClosureRepository implements LotClosureRepositoryPort {
  async encerrarPorPrazo() {
    const rows = await query<{ id: string }>(`UPDATE lots SET status = 'encerrado', closed_reason = 'prazo', closed_at = now()
      WHERE status IN ('aberto','agendado') AND ${VENCIDO} RETURNING id`);
    return rows.length;
  }

  async encerrarPorAusencia(ciclos: number, limite: number) {
    const rows = await query<{ id: string }>(`WITH varreduras AS (
      SELECT source_id, started_at,
             row_number() OVER (PARTITION BY source_id ORDER BY started_at DESC) AS n
        FROM collection_runs
       WHERE job IN ('collect','collect:cli') AND ok AND limite >= $2
    ), corte AS (
      SELECT source_id, min(started_at) AS desde
        FROM varreduras WHERE n <= $1
       GROUP BY source_id
      HAVING count(*) = $1
    )
    UPDATE lots l SET status = 'encerrado', closed_reason = 'ausente_na_fonte', closed_at = now()
      FROM corte c
     WHERE l.source_id = c.source_id
       AND l.status IN ('aberto','agendado')
       AND l.collected_at < c.desde
     RETURNING l.id`, [ciclos, limite]);
    return rows.length;
  }

  candidatos(fontes: string[], limite: number, teto: number) {
    return query<CandidatoVerificacao>(`WITH ult AS (
      SELECT source_id, max(started_at) u FROM collection_runs
       WHERE job IN ('collect','collect:cli') AND ok AND limite >= $2 GROUP BY 1)
    SELECT l.id, l.source_id, l.external_id, l.lot_url, l.source_category
      FROM lots l JOIN ult ON ult.source_id = l.source_id
     WHERE l.source_id = ANY($1)
       AND l.status IN ('aberto','agendado','sem_data')
       AND (l.collected_at < ult.u
            OR (l.status = 'sem_data' AND l.auction_start_utc < now() - interval '24 hours'))
       AND (l.verified_at IS NULL
            OR (l.verify_result = 'EM LOTEAMENTO' AND l.verified_at < now() - interval '1 hour')
            OR l.verified_at < now() - (interval '6 hours' * GREATEST(1, l.verify_fails)))
     ORDER BY l.verified_at NULLS FIRST, random()
     LIMIT $3`, [fontes, limite, teto]);
  }

  async aplicarVereditos(mortos: Array<{ id: number; sinal: string }>, vivos: Array<{ id: number; sinal: string }>, indeterminados: Array<{ id: number; sinal: string }>) {
    if (mortos.length) await query(`UPDATE lots SET status='encerrado', closed_reason='verificado_na_fonte', closed_at=now(),
      verified_at=now(), verify_result=d.sinal, verify_fails=0
      FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d WHERE lots.id = d.id`,
    [mortos.map((m) => m.id), mortos.map((m) => m.sinal.slice(0, 120))]);
    if (vivos.length) await query(`UPDATE lots SET verified_at=now(), verify_result=d.sinal, verify_fails=0
      FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d WHERE lots.id = d.id`,
    [vivos.map((m) => m.id), vivos.map((m) => m.sinal.slice(0, 120))]);
    if (indeterminados.length) await query(`UPDATE lots SET verified_at=now(), verify_result=d.sinal, verify_fails=verify_fails+1
      FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d WHERE lots.id = d.id`,
    [indeterminados.map((m) => m.id), indeterminados.map((m) => m.sinal.slice(0, 120))]);
  }

  async corrigirPrazo(vereditos: Array<{ id: number; fimUtc: string }>) {
    if (!vereditos.length) return;
    await query(`UPDATE lots SET auction_end_utc = d.fim
      FROM (SELECT unnest($1::bigint[]) id, unnest($2::timestamptz[]) fim) d
     WHERE lots.id = d.id
       AND (lots.auction_end_utc IS NULL
            OR abs(extract(epoch FROM (lots.auction_end_utc - d.fim))) >= 3600)`,
    [vereditos.map((p) => p.id), vereditos.map((p) => p.fimUtc)]);
  }
}
