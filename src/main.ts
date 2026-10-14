import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { configureSwagger } from './infra/config/swagger.js';

export async function createNestApplication(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  configureSwagger(app);
  return app;
}

if (process.env.NEST_BOOTSTRAP === '1') {
  const app = await createNestApplication();
  await app.listen(Number(process.env.PORT ?? 4500), '127.0.0.1');
}
