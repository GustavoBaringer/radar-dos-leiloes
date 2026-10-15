import { query } from '../query.js';

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  owner_id: number;
}

export class NotificationSubscriptionsRepository {
  constructor(private readonly queryFn: typeof query = query) {}

  async ultimaEntrega(alertId: number, canal: string): Promise<number | null> {
    const [r] = await this.queryFn<{ ultimo: string | null }>(
      'SELECT max(created_at)::text AS ultimo FROM alert_hits WHERE alert_id = $1 AND $2 = ANY(notified)',
      [alertId, canal],
    );
    return r?.ultimo ? Date.parse(r.ultimo) : null;
  }

  listarAtivas(): Promise<PushSubscriptionRow[]> {
    return this.queryFn<PushSubscriptionRow>(
      'SELECT endpoint, p256dh, auth, owner_id FROM push_subscriptions WHERE failures < 5 AND owner_id IS NOT NULL',
    );
  }

  async remover(endpoint: string): Promise<void> {
    await this.queryFn('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  }

  async incrementarFalhas(endpoint: string): Promise<void> {
    await this.queryFn('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1', [endpoint]);
  }
}
