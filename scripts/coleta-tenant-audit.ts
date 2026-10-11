export function normalizeHost(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host.includes('.') ? host : null;
  } catch { return null; }
}

export function normalizeLotUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch { return null; }
}

export function guardTenantLots<T extends { lotUrl?: string | null }>(lots: T[], host: string, limit: number) {
  const accepted: T[] = [], rejected: T[] = [];
  for (const lot of lots.slice(0, limit)) (normalizeHost(lot.lotUrl) === host ? accepted : rejected).push(lot);
  return { accepted, rejected, overLimit: Math.max(0, lots.length - limit) };
}
