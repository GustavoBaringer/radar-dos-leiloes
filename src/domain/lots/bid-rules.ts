/** Lance implausível é da fonte, não do parser. */
export function isBidSuspect(bid?: number | null, appraisal?: number | null): boolean {
  if (bid == null || bid <= 0) return false;
  if (appraisal && appraisal > 0 && bid > appraisal * 20) return true;
  if (appraisal && appraisal > 1000 && bid < appraisal * 0.02) return true;
  return bid > 3_000_000;
}
