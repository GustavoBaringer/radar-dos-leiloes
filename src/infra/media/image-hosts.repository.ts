import type { RadarHttpContext } from '../http/radar-http-context.js';

const KNOWN_HOSTS = [
  'www.claudiokussleiloes.com.br', 'claudiokussleiloes.com.br', 'ms.sbwebservices.net',
  'static.s4bdigital.net', 'brimages.copart.com.br', 'leilo.cdndp.com.br',
  'cdn3.freitasleiloeiro.com.br', 's3-sa-east-1.amazonaws.com', 'www.freitasleiloeiro.com.br',
  'www.leilaoeletronico.com.br', 'leilaoeletronico.com.br', 'www.casadeleiloes.com.br',
  'casadeleiloes.com.br', 'rochaleiloes.com.br', 'static.liderleiloes.com.br',
];

/** Static compatibility hosts plus hosts actually referenced by persisted lots. */
export async function loadImageHosts(context: RadarHttpContext): Promise<Set<string>> {
  const hosts = new Set(KNOWN_HOSTS);
  try {
    const rows = await context.data.query<{ host: string }>(`SELECT split_part(split_part(p, '://', 2), '/', 1) AS host, count(*)::int AS n
      FROM lots, LATERAL jsonb_array_elements_text(photos) AS p
      WHERE p LIKE 'https://%' GROUP BY 1 HAVING count(*) > 0`);
    for (const { host } of rows) if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) hosts.add(host.toLowerCase());
  } catch { /* The first boot may have no database rows available yet. */ }
  return hosts;
}

export function imageHostAllowed(hosts: ReadonlySet<string>, host: string): boolean {
  return hosts.has(host) || (host.startsWith('www.') && hosts.has(host.slice(4)));
}
