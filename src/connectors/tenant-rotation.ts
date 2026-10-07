/** Mirrors the current cron (07h, 13h, 18h) in the worker's local timezone. */
export function collectRotationSlot(date = new Date()): number {
  const hour = date.getHours();
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  const slot = hour >= 18 ? 2 : hour >= 13 ? 1 : hour >= 7 ? 0 : -1;
  return (day + (slot < 0 ? -1 : 0)) * 3 + (slot < 0 ? 2 : slot);
}

export function rotateTenants(candidates: readonly string[], limit: number, date = new Date()): string[] {
  const count = Math.floor(limit);
  if (!Number.isFinite(limit) || count < 1) throw new RangeError('limit must be a positive finite number');
  const unique = [...new Set(candidates)];
  if (!unique.length) return [];
  const pageSize = Math.min(count, unique.length);
  // ponytail: missed/delayed cron slots can delay coverage; persist a cursor if guarantees are needed.
  const start = (collectRotationSlot(date) * pageSize) % unique.length;
  return Array.from({ length: pageSize }, (_, i) => unique[(start + i) % unique.length]);
}
