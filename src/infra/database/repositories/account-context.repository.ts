import { VENCIDO } from '../queries/lot-status.js';

export type AccountContextQuery = (sql: string, params?: any[]) => Promise<any[]>;

export const VISIBLE_FAVORITE_PREDICATE = `l.status NOT IN ('encerrado','vendido') AND NOT ${VENCIDO}`;

export class AccountContextRepository {
  constructor(private readonly queryFn: AccountContextQuery) {}

  async favoriteCount(ownerId: number): Promise<{ count: number | string } | undefined> {
    const [favorites] = await this.queryFn(
      `SELECT count(*)::int AS count
         FROM favorites f
         JOIN lots l ON l.id = f.lot_id
        WHERE f.owner_id = $1 AND ${VISIBLE_FAVORITE_PREDICATE}`,
      [ownerId],
    );
    return favorites;
  }

  async unreadAlertCount(ownerId: number): Promise<{ count: number | string } | undefined> {
    const [unread] = await this.queryFn(
      `SELECT count(*)::int AS count
         FROM alert_hits h
         JOIN alerts a ON a.id = h.alert_id
        WHERE a.owner_id = $1 AND NOT h.seen`,
      [ownerId],
    );
    return unread;
  }

  favoriteLotIds(ownerId: number, ids: number[]): Promise<Array<{ lot_id: number | string }>> {
    return this.queryFn(
      `SELECT lot_id FROM favorites WHERE owner_id = $1 AND lot_id = ANY($2::int[])`,
      [ownerId, ids],
    );
  }
}
