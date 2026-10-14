import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { configureSwagger } from './infra/config/swagger.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function createNestApplication(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  configureSwagger(app);
  return app;
}

async function startNativeEntry(): Promise<void> {
  const [{ createNativeHttpOptions }, { createRadarApplication }] = await Promise.all([
    import('./bootstrap/native-http-options.js'), import('./bootstrap/native-application.js'),
  ]);
  const options = await createNativeHttpOptions(process.env, import.meta.url);
  const app = await createRadarApplication(options);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= app.close();
  const onShutdown = () => { void close().catch((error) => { console.error('Falha ao encerrar a aplicação nativa:', error); process.exitCode = 1; }); };
  process.once('SIGINT', onShutdown);
  process.once('SIGTERM', onShutdown);
  try {
    await app.listen(Number(process.env.PORT ?? 4500), process.env.BIND_HOST ?? '127.0.0.1');
  } catch (error) {
    await close();
    throw error;
  }
}

const invokedAsEntry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsEntry && process.env.NEST_BOOTSTRAP === '1') await startNativeEntry();
