import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DiscoveryModule, type DiscoveryModuleOptions } from '../application/modules/discovery/discovery.module.js';
import { DiscoveryService } from '../application/services/discovery/discovery.service.js';

export async function createDiscoveryContext(options: DiscoveryModuleOptions = {}) {
  const app = await NestFactory.createApplicationContext(DiscoveryModule.forRoot(options), { logger: false, abortOnError: false });
  const service = app.get(DiscoveryService);
  let closing: Promise<void> | undefined;
  return { app, service, close: () => closing ??= app.close() };
}

export type DiscoveryContext = Awaited<ReturnType<typeof createDiscoveryContext>>;
