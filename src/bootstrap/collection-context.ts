import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CollectionModule, type CollectionModuleOptions } from '../application/modules/collection/collection.module.js';
import { CollectionService } from '../application/services/collection/collection.service.js';

/** No HTTP application, listener, auth module or Redis publisher is created here. */
export async function createCollectionContext(options: CollectionModuleOptions = {}) {
  const app = await NestFactory.createApplicationContext(CollectionModule.forRoot(options), { logger: false, abortOnError: false });
  const service = app.get(CollectionService);
  let closing: Promise<void> | undefined;
  return {
    app,
    service,
    close: () => closing ??= (async () => {
      await service.drain();
      await app.close();
    })(),
  };
}

export type CollectionContext = Awaited<ReturnType<typeof createCollectionContext>>;
