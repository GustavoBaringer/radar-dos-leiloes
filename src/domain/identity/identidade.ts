import type { Papel } from './session.js';

export interface Identidade {
  userId: number;
  sub: string | null;
  email: string | null;
  nome: string | null;
  papel: Papel;
}

/** Anonymous visitors never own a persisted account. */
export const ANONIMO: Identidade = { userId: 0, sub: null, email: null, nome: null, papel: 'comum' };
