import type { PublicLot } from './public-dto.js';
import { VENCIDO } from './encerramento.js';

export type AccountContextQuery = (sql: string, params?: any[]) => Promise<any[]>;

export const VISIBLE_FAVORITE_PREDICATE = `l.status NOT IN ('encerrado','vendido') AND NOT ${VENCIDO}`;

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

const requireUserId = (userId: unknown): number => {
  if (!Number.isSafeInteger(userId) || (userId as number) <= 0) {
    throw new AccountContextError(401, 'Autenticação necessária.');
  }
  return userId as number;
};

const MAX_LOTS = 100;

export function createAccountContext(queryFn: AccountContextQuery) {
  async function summarize(userId: number): Promise<{ favoriteCount: number; unreadAlertCount: number }> {
    const ownerId = requireUserId(userId);
    const [favorites] = await queryFn(
      `SELECT count(*)::int AS count
         FROM favorites f
         JOIN lots l ON l.id = f.lot_id
        WHERE f.owner_id = $1 AND ${VISIBLE_FAVORITE_PREDICATE}`,
      [ownerId],
    );
    const [unread] = await queryFn(
      `SELECT count(*)::int AS count
         FROM alert_hits h
         JOIN alerts a ON a.id = h.alert_id
        WHERE a.owner_id = $1 AND NOT h.seen`,
      [ownerId],
    );
    return {
      favoriteCount: Number(favorites?.count ?? 0),
      unreadAlertCount: Number(unread?.count ?? 0),
    };
  }

  async function decorateLots<T extends PublicLot>(userId: number, lots: readonly T[]): Promise<Array<T & { favorited: boolean }>> {
    const ownerId = requireUserId(userId);
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

    const rows = ids.length
      ? await queryFn(
          `SELECT lot_id FROM favorites WHERE owner_id = $1 AND lot_id = ANY($2::int[])`,
          [ownerId, ids],
        )
      : [];
    const favorited = new Set(rows.map((row) => Number(row.lot_id)));
    return lots.map((lot) => ({ ...lot, favorited: favorited.has(lot.id) }));
  }

  return { summarize, decorateLots };
}
