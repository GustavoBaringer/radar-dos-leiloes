import type { PublicLot } from '../lots/public-dto.js';

export function buildMePayload<T extends { papel: unknown; oidc: unknown; logado: unknown; conta: { id: number; email: unknown; nome: unknown; porProvedor: boolean } }>(
  identity: T,
  summary: { favoriteCount: number; unreadAlertCount: number },
) {
  const { papel, oidc, logado, conta } = identity;
  return { papel, oidc, logado, conta, favoriteCount: summary.favoriteCount, unreadAlertCount: summary.unreadAlertCount };
}

export class AccountContextError extends Error {
  readonly statusCode: 400 | 401;
  constructor(statusCode: 400 | 401, message: string) {
    super(message);
    this.name = 'AccountContextError';
    this.statusCode = statusCode;
  }
}

export const requireUserId = (userId: unknown): number => {
  if (!Number.isSafeInteger(userId) || (userId as number) <= 0) {
    throw new AccountContextError(401, 'Autenticação necessária.');
  }
  return userId as number;
};

const MAX_LOTS = 100;

export function lotIds(lots: readonly PublicLot[]): number[] {
  if (!Array.isArray(lots) || lots.length > MAX_LOTS) {
    throw new AccountContextError(400, 'Lista de lotes inválida.');
  }
  const ids: number[] = [];
  const unique = new Set<number>();
  for (const lot of lots) {
    const id: unknown = lot?.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) {
      throw new AccountContextError(400, 'Identificador de lote inválido.');
    }
    if (!unique.has(id as number)) {
      unique.add(id as number);
      ids.push(id as number);
    }
  }
  return ids;
}
