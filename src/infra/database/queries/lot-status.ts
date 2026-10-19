/** Database-side deadline expressions shared by list/status persistence SQL. */
export const VENCIDO = `COALESCE(
  (closing_model = 'timer_por_lote' AND auction_end_utc < now())
  OR (closing_model <> 'timer_por_lote' AND auction_start_utc <= now())
, FALSE)`;

export const TERMINAL = `(status IN ('encerrado','vendido') OR ${VENCIDO})`;
