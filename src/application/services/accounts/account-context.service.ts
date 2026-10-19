import { Inject, Injectable } from '@nestjs/common';
import type { PublicLot } from '../../../domain/lots/public-dto.js';
import { lotIds, requireUserId } from '../../../domain/accounts/account-context.js';
import { AccountContextRepository } from '../../../infra/database/repositories/account-context.repository.js';

@Injectable()
export class AccountContextService {
  constructor(@Inject(AccountContextRepository) private readonly repository: AccountContextRepository) {}

  async summarize(userId: number): Promise<{ favoriteCount: number; unreadAlertCount: number }> {
    const ownerId = requireUserId(userId);
    const favorites = await this.repository.favoriteCount(ownerId);
    const unread = await this.repository.unreadAlertCount(ownerId);
    return {
      favoriteCount: Number(favorites?.count ?? 0),
      unreadAlertCount: Number(unread?.count ?? 0),
    };
  }

  async decorateLots<T extends PublicLot>(userId: number, lots: readonly T[]): Promise<Array<T & { favorited: boolean }>> {
    const ownerId = requireUserId(userId);
    const ids = lotIds(lots);
    const rows = ids.length
      ? await this.repository.favoriteLotIds(ownerId, ids)
      : [];
    const favorited = new Set(rows.map((row) => Number(row.lot_id)));
    return lots.map((lot) => ({ ...lot, favorited: favorited.has(lot.id) }));
  }
}
