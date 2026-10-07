import { isIP } from 'node:net';

const parseV6 = (input: string): number[] | null => {
  if (input.includes('%')) return null;
  let value = input.toLowerCase();
  const embedded = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const ipv4 = embedded[1].split('.').map(Number);
    if (ipv4.some((n) => n < 0 || n > 255)) return null;
    const hex = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    value = value.slice(0, -embedded[1].length) + hex;
  }
  if (isIP(value) !== 6) return null;
  const [leftRaw, rightRaw, ...rest] = value.split('::');
  if (rest.length) return null;
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const missing = 8 - left.length - right.length;
  const parts = value.includes('::')
    ? [...left, ...Array<number>(missing).fill(0).map(String), ...right]
    : left;
  if (parts.length !== 8) return null;
  const nums = parts.map((part) => Number.parseInt(part, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
};

const formatV6 = (parts: number[]): string => {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < parts.length;) {
    if (parts[i] !== 0) { i++; continue; }
    let j = i;
    while (j < parts.length && parts[j] === 0) j++;
    if (j - i > bestLength) { bestStart = i; bestLength = j - i; }
    i = j;
  }
  if (bestStart < 0) return parts.map((n) => n.toString(16)).join(':');
  const before = parts.slice(0, bestStart).map((n) => n.toString(16)).join(':');
  const after = parts.slice(bestStart + bestLength).map((n) => n.toString(16)).join(':');
  return `${before}::${after}`;
};

export function normalizeClientIp(address: string): string {
  const input = String(address ?? '').trim();
  const unwrapped = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (isIP(unwrapped) === 4) return unwrapped.split('.').map((part) => String(Number(part))).join('.');
  const parts = parseV6(unwrapped);
  if (!parts) throw new Error('endereço IP inválido');
  if (parts.slice(0, 5).every((n) => n === 0) && parts[5] === 0xffff) {
    return `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
  }
  return formatV6(parts);
}
