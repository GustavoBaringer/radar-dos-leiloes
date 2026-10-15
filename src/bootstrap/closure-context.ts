import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ClosureModule, type ClosureModuleOptions } from '../application/modules/closure/closure.module.js';
import { LotClosureService } from '../application/services/closure/lot-closure.service.js';

export async function createClosureContext(options: ClosureModuleOptions = {}) {
  const app = await NestFactory.createApplicationContext(ClosureModule.forRoot(options), { logger: false, abortOnError: false });
  const service = app.get(LotClosureService);
  let closing: Promise<void> | undefined;
  return { app, service, close: () => closing ??= app.close() };
}

export type ClosureContext = Awaited<ReturnType<typeof createClosureContext>>;
