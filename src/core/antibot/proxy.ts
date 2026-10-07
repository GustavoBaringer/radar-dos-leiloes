import { isIP } from 'node:net';

export interface ProxyTrustConfig {
  readonly trustedProxyCidrs: readonly string[];
  readonly trustProxy: false | readonly string[];
  readonly originProtectionConfirmed: boolean;
}

// Rede IPv4-mapped (::ffff:0.0.0.0/96): qualquer prefixo IPv6 cuja máscara
// coincida com ela cobre TODOS os clientes IPv4 quando o proxy-addr converte
// peers IPv4 para o formato mapeado antes de casar contra subnets IPv6.
const MAPPED_V4_BYTES = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0]);

function ipv6Bytes(address: string): Uint8Array {
  const [head, tail, extra] = address.split('::');
  if (extra !== undefined) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS contém IPv6 inválido');
  const groups: number[] = [];
  const push = (part: string): void => {
    if (!part) return;
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const octets = group.split('.').map(Number);
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        groups.push(Number.parseInt(group, 16));
      }
    }
  };
  push(head);
  const headCount = groups.length;
  if (address.includes('::')) push(tail);
  const tailCount = groups.length - headCount;
  const gap = 8 - headCount - tailCount;
  if (gap < 0) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS contém IPv6 inválido');
  const filled = address.includes('::')
    ? [...groups.slice(0, headCount), ...new Array<number>(gap).fill(0), ...groups.slice(headCount)]
    : groups;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index++) {
    bytes[index * 2] = (filled[index] >> 8) & 0xff;
    bytes[index * 2 + 1] = filled[index] & 0xff;
  }
  return bytes;
}

// True quando o subnet cobre integralmente o espaço IPv4-mapped e, por isso,
// aceitaria qualquer IP IPv4 como proxy confiável.
function coversEveryMappedIPv4(address: string, prefix: number): boolean {
  if (prefix > 96) return false;
  const bytes = ipv6Bytes(address);
  const wholeBytes = prefix >>> 3;
  const remainingBits = prefix & 7;
  for (let index = 0; index < wholeBytes; index++) {
    if (bytes[index] !== MAPPED_V4_BYTES[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes] & mask) === (MAPPED_V4_BYTES[wholeBytes] & mask);
}

function parseEntry(raw: string): string {
  const value = raw.trim();
  if (!value || value === '*' || value.toLowerCase() === 'true') throw new Error('ANTIBOT_TRUST_PROXY_CIDRS contém entrada inválida');
  const [address, prefixText, extra] = value.split('/');
  if (extra !== undefined || !address || isIP(address) === 0) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS deve conter IPs/CIDRs válidos');
  const version = isIP(address);
  if (prefixText === undefined) {
    if (address === '0.0.0.0' || address === '::') throw new Error('ANTIBOT_TRUST_PROXY_CIDRS não aceita endereço não especificado');
    return address;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(prefixText)) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS contém prefixo inválido');
  const prefix = Number(prefixText);
  const maximum = version === 4 ? 32 : 128;
  if (prefix <= 0 || prefix > maximum) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS não aceita prefixo global ou fora do intervalo');
  if (version === 6 && coversEveryMappedIPv4(address, prefix)) {
    throw new Error('ANTIBOT_TRUST_PROXY_CIDRS não aceita cobertura ampla (mapeada IPv4) de todos os clientes');
  }
  return `${address}/${prefix}`;
}

export function loadProxyTrustConfig(env: NodeJS.ProcessEnv): ProxyTrustConfig {
  const raw = env.ANTIBOT_TRUST_PROXY_CIDRS;
  const entries = raw?.trim() ? raw.split(',').map(parseEntry) : [];
  if (entries.length > 20) throw new Error('ANTIBOT_TRUST_PROXY_CIDRS aceita no máximo 20 entradas');
  const cidrs = [...new Set(entries)];
  const confirmed = env.ANTIBOT_ORIGIN_PROTECTION_CONFIRMED === '1';
  if (env.NODE_ENV === 'production' && cidrs.length > 0 && !confirmed) {
    throw new Error('Trust proxy em produção exige ANTIBOT_ORIGIN_PROTECTION_CONFIRMED=1');
  }
  return {
    trustedProxyCidrs: Object.freeze(cidrs),
    trustProxy: cidrs.length ? Object.freeze([...cidrs]) : false,
    originProtectionConfirmed: confirmed,
  };
}
