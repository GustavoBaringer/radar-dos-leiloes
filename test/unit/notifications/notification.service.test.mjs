import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import { NotificationsModule } from '../../../dist/src/application/modules/notifications/notifications.module.js';
import { NotificationService } from '../../../dist/src/application/services/notifications/notification.service.js';

const hit = (lotId, alertId = 1, ownerId = 7) => ({
  lotId, alertId, ownerId, label: 'Mesmo nome', channels: ['sino', 'push', 'email'],
  email: `owner${ownerId}@example.test`, title: '<lote>', lotUrl: 'javascript:alert(1)', bid: null, source: '<teste>',
});

async function fixture() {
  const sent = [], marked = [], removed = [], failed = [], windows = [], emails = [];
  let smtpCreated = 0;
  const ports = {
    repository: {
      listarAtivas: async () => ['ok', 'dead404', 'dead410', 'failed', 'foreign'].map(endpoint => ({
        endpoint, owner_id: endpoint === 'foreign' ? 8 : 7, p256dh: 'key', auth: 'auth',
      })),
      remover: async endpoint => { removed.push(endpoint); },
      incrementarFalhas: async endpoint => { failed.push(endpoint); },
      ultimaEntrega: async (id, channel) => { windows.push([id, channel]); return channel === 'push' ? Date.now() : null; },
    },
    push: { enabled: true, send: async (subscription, payload) => {
      if (subscription.endpoint.startsWith('dead')) throw { statusCode: Number(subscription.endpoint.slice(4)) };
      if (subscription.endpoint === 'failed') throw { statusCode: 503 };
      sent.push([subscription.endpoint, JSON.parse(payload)]);
    } },
    env: { SMTP_HOST: 'fake-not-used' },
    smtp: async () => { smtpCreated++; return { sendMail: async message => { emails.push(message); } }; },
    mark: async (...args) => { marked.push(args); },
  };
  const app = await NestFactory.createApplicationContext(NotificationsModule.forRoot(ports), { logger: false });
  return { app, service: await app.resolve(NotificationService), ports, sent, marked, removed, failed, windows, emails,
    get smtpCreated() { return smtpCreated; } };
}

describe('NotificationService native Nest DI with isolated ports', () => {
  it('groups owner/alert, cleans dead devices, counts other failures and marks only delivered groups', async () => {
    const f = await fixture();
    try {
      expect(f.service).toBeInstanceOf(NotificationService);
      expect(await f.service.enviarPush([hit(1), hit(2), hit(1), hit(3, 2), hit(4, 3, 9)])).toBe(2);
      expect(f.sent.map(([endpoint]) => endpoint)).toEqual(['ok', 'ok']);
      expect(f.sent.map(([, payload]) => payload.url)).toEqual(['/alertas?alertId=1', '/alertas?alertId=2']);
      expect(f.sent[0][1].body).toContain('2 novos lotes');
      expect(f.marked).toEqual([[1, 1, 'push'], [1, 2, 'push'], [2, 3, 'push']]);
      expect(f.removed).toEqual(['dead404', 'dead410', 'dead404', 'dead410']);
      expect(f.failed).toEqual(['failed', 'failed']);
      f.ports.push.enabled = false;
      expect(await f.service.enviarPush([hit(5)])).toBe(0);
      expect(f.marked).toHaveLength(3);
    } finally { await f.app.close(); }
  });

  it('memoizes independent channel windows and creates one SMTP adapter per call, not per group', async () => {
    const f = await fixture();
    try {
      const result = await f.service.aplicarLimitesDeEntrega([hit(1), hit(2), hit(3, 2, 8)], { push: 60, email: 60 });
      expect(result.adiados).toBe(3);
      expect(result.disparos.map(d => d.channels)).toEqual(Array(3).fill(['sino', 'email']));
      expect(f.windows).toEqual([[1, 'push'], [1, 'email'], [2, 'push'], [2, 'email']]);
      expect(await f.service.enviarEmail(result.disparos)).toEqual({ enviados: 2, pendentes: 0 });
      expect(f.smtpCreated).toBe(1);
      expect(f.emails.map(message => message.to)).toEqual(['owner7@example.test', 'owner8@example.test']);
      expect(f.emails[0].html).toContain('&lt;lote&gt;');
      expect(f.emails[0].html).not.toContain('javascript:');
      expect(f.marked).toEqual([[1, 1, 'email'], [1, 2, 'email'], [2, 3, 'email']]);
    } finally { await f.app.close(); }
  });

  it('keeps failed deliveries pending and never marks them', async () => {
    const f = await fixture();
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.ports.repository.listarAtivas = async () => [{ endpoint: 'failed', owner_id: 7, p256dh: 'key', auth: 'auth' }];
      expect(await f.service.enviarPush([hit(1)])).toBe(0);
      f.ports.env = {};
      expect(await f.service.enviarEmail([hit(1)])).toEqual({ enviados: 0, pendentes: 1 });
      expect(f.smtpCreated).toBe(0);
      f.ports.env = { SMTP_HOST: 'fake-not-used' };
      f.ports.smtp = async () => ({ sendMail: async () => { throw Error('offline'); } });
      expect(await f.service.enviarEmail([hit(1)])).toEqual({ enviados: 0, pendentes: 1 });
      expect(f.marked).toEqual([]);
    } finally { warning.mockRestore(); await f.app.close(); }
  });
});
