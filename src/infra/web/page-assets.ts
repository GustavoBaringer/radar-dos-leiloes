import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { RadarHttpContext } from '../http/radar-http-context.js';
import { PagesRepository } from './pages.repository.js';

/** Register the same content-addressed app asset mount as the legacy host. */
export async function configurePageAssets(app: NestFastifyApplication, context: RadarHttpContext): Promise<void> {
  const pages = new PagesRepository(context);
  if (!pages.hasSpa()) return;
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  await fastify.register(fastifyStatic, {
    root: join(context.paths.appDist, 'client', 'assets'), prefix: '/assets/', decorateReply: false,
    maxAge: '1y', immutable: true,
  });
}
