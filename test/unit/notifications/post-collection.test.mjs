import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PostCollectionService, POST_COLLECTION_EVALUATE } from '../../../dist/src/application/services/collection/post-collection.js';
import { NotificationService } from '../../../dist/src/application/services/notifications/notification.service.js';

async function fixture(failAt) {
  const order = [];
  const disparos = [{ alertId: 1, ownerId: 7, lotId: 1 }];
  const step = (name, result) => async () => {
    order.push(name);
    if (failAt === name) throw Error(name);
    return result;
  };
  class Root {}
  Module({ providers: [PostCollectionService,
    { provide: POST_COLLECTION_EVALUATE, useValue: step('evaluate', disparos) },
    { provide: NotificationService, useValue: {
      aplicarLimitesDeEntrega: step('limits', { disparos, adiados: 2 }),
      enviarPush: step('push', 3), enviarEmail: step('email', { enviados: 4, pendentes: 5 }),
    } },
  ] })(Root);
  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  return { app, service: await app.resolve(PostCollectionService), order, disparos,
    publish: step('publish', undefined) };
}

describe('PostCollectionService native DI orchestration', () => {
  it('preserves evaluate → publish → limits → push → email and exact counts', async () => {
    const f = await fixture();
    try {
      const publish = jest.fn(async payload => { expect(payload).toEqual({ type: 'alertas', disparos: f.disparos }); await f.publish(); });
      expect(await f.service.processarAposColeta([1], publish, { push: 60 })).toEqual({ disparos: 1, push: 3, emails: 4, pendentesEmail: 5, adiados: 2 });
      expect(f.order).toEqual(['evaluate', 'publish', 'limits', 'push', 'email']);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });

  it('does no I/O for empty IDs and catches every post-commit failure without continuing delivery', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const empty = { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 };
    try {
      for (const phase of ['evaluate', 'publish', 'limits', 'push', 'email']) {
        const f = await fixture(phase);
        try {
          expect(await f.service.processarAposColeta([], f.publish, {})).toEqual(empty);
          expect(f.order).toEqual([]);
          expect(await f.service.processarAposColeta([1], f.publish, {})).toEqual(empty);
          expect(f.order).toEqual(['evaluate', 'publish', 'limits', 'push', 'email'].slice(0, ['evaluate', 'publish', 'limits', 'push', 'email'].indexOf(phase) + 1));
        } finally { await f.app.close(); }
      }
      expect(error).toHaveBeenCalledTimes(5);
    } finally { error.mockRestore(); }
  });
});
