const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

// Sequência repetida (111.111.111-11) passa no dígito verificador e não é documento.
const repetido = (d: string) => /^(\d)\1+$/.test(d);

function digitoCpf(base: string): number {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
  const r = (soma * 10) % 11;
  return r === 10 ? 0 : r;
}

export function cpfValido(v: unknown): boolean {
  const d = soDigitos(v);
  if (d.length !== 11 || repetido(d)) return false;
  return digitoCpf(d.slice(0, 9)) === Number(d[9]) && digitoCpf(d.slice(0, 10)) === Number(d[10]);
}

function digitoCnpj(base: string): number {
  const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += Number(base[i]) * pesos[i];
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function cnpjValido(v: unknown): boolean {
  const d = soDigitos(v);
  if (d.length !== 14 || repetido(d)) return false;
  return digitoCnpj(d.slice(0, 12)) === Number(d[12]) && digitoCnpj(d.slice(0, 13)) === Number(d[13]);
}

export function documento(v: unknown): { tipo: 'CPF' | 'CNPJ'; digitos: string } | null {
  const d = soDigitos(v);
  if (d.length === 11 && cpfValido(d)) return { tipo: 'CPF', digitos: d };
  if (d.length === 14 && cnpjValido(d)) return { tipo: 'CNPJ', digitos: d };
  return null;
}

/** Aceita fixo (10 dígitos) e celular (11, com 9 depois do DDD). Retorna só dígitos ou null. */
export function celularValido(v: unknown): string | null {
  let d = soDigitos(v);
  // +55 colado pelo autopreenchimento do navegador.
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || d[1] === '0') return null;
  if (d.length === 11 && d[2] !== '9') return null;
  if (d.length === 10 && !/[2-5]/.test(d[2])) return null;
  if (repetido(d.slice(2))) return null;
  return d;
}

export function emailValido(v: unknown): boolean {
  const e = String(v ?? '').trim();
  return e.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}
