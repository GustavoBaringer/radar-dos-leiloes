import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadAntibotConfig } from '../../../core/antibot/config.js';
import { createWsProtection, type WsSocket } from '../../../core/antibot/ws.js';
import type { Papel } from '../../../infra/auth/session.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';

export interface RealtimeActor { userId: number; papel: Papel }
export interface RealtimePeer {
  readonly bufferedAmount?: number;
  send(data: string): boolean;
  close(): void;
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly clients = new Map<RealtimePeer, RealtimeActor>();
  private subscriber?: Awaited<ReturnType<RadarHttpContext['redisResource']>>;
  private protection?: ReturnType<typeof createWsProtection>;
  private messageListener?: (channel: string, message: string) => void;
  private errorListener?: () => void;
  private readonly channel: string;
  private subscriberErrorLogged = false;
  private closing?: Promise<void>;

  constructor(@Inject(RadarHttpContext) private readonly context: RadarHttpContext) {
    this.channel = context.runtime.CHANNEL_UPDATES;
  }

  async onModuleInit(): Promise<void> {
    const config = loadAntibotConfig(this.context.env);
    const wsRedis = config.mode === 'off' ? undefined : await this.context.redisResource('ws');
    this.protection = createWsProtection({ mode: config.mode, environment: config.environment,
      redisUrl: config.redisUrl, ownedRedisClient: wsRedis as never,
      onEvent: (event, outcome) => this.context.telemetry.observeWs(event, outcome) });
    this.subscriber = await this.context.redisResource('subscriber');
    this.messageListener = (channel, message) => { if (channel === this.channel) this.publish(message); };
    this.subscriber.on('message', this.messageListener);
    this.errorListener = () => {
      if (!this.subscriberErrorLogged) { this.subscriberErrorLogged = true; console.warn('[ws] subscriber unavailable'); }
    };
    this.subscriber.on('error', this.errorListener);
    await this.subscriber.subscribe(this.channel);
  }

  onModuleDestroy(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.subscriber && this.messageListener) {
      this.subscriber.off('message', this.messageListener);
      if (this.errorListener) this.subscriber.off('error', this.errorListener);
      try { await this.subscriber.unsubscribe(this.channel); } catch { /* context owns and closes this client */ }
    }
    await this.protection?.close();
    this.clients.clear();
  }

  get protectionEngine() { return this.protection; }
  get clientCount(): number { return this.clients.size; }

  connect(actor: RealtimeActor | undefined, peer: RealtimePeer): boolean {
    if (!Number.isSafeInteger(actor?.userId) || (actor!.userId as number) <= 0) { peer.close(); return false; }
    this.clients.set(peer, actor!);
    if (!peer.send(JSON.stringify({ type: 'hello', ts: Date.now() }))) {
      this.clients.delete(peer);
      return false;
    }
    return true;
  }
  disconnect(peer: RealtimePeer): void { this.clients.delete(peer); }

  private publish(raw: string): void {
    let data: any;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (data.type === 'alertas') {
      const alerts = Array.isArray(data.disparos) ? data.disparos : [];
      for (const [peer, actor] of this.clients) {
        const mine = alerts.filter((alert: any) => alert && alert.ownerId === actor.userId).map((alert: any) => ({
          alertId: alert.alertId, label: alert.label, lotId: alert.lotId, title: alert.title,
          lotUrl: alert.lotUrl, bid: alert.bid, source: alert.source,
        }));
        if (mine.length && !peer.send(JSON.stringify({ type: 'alertas', disparos: mine }))) this.clients.delete(peer);
      }
      return;
    }
    const adminOnly = data.type === 'collect' || data.type === 'encerrados';
    for (const [peer, actor] of this.clients) {
      if (adminOnly && actor.papel !== 'admin') continue;
      if (!peer.send(raw)) this.clients.delete(peer);
    }
  }
}
