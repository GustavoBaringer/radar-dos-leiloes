import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module.js';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../infra/http/http-platform.js';
import type { RadarHttpOptions } from '../infra/http/http-contracts.js';
import { RADAR_HTTP_CONTEXT } from '../application/modules/http-platform/http-platform.module.js';
import { RealtimeService } from '../application/services/realtime/realtime.service.js';
import { configureWebsocketTransport, registerWebsocketPlugin } from '../infra/websocket/websocket-transport.adapter.js';
import { configureSwagger } from '../infra/config/swagger.js';
import { configurePageAssets } from '../infra/web/page-assets.js';

/** Builds and initializes the full native application without opening a listener. */
export async function createRadarApplication(options: RadarHttpOptions): Promise<NestFastifyApplication> {
  if (!options.dependencies.oidc.oidcLigado()) throw new Error('OIDC obrigatório para iniciar a aplicação nativa.');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(options), new FastifyAdapter(radarHttpAdapterOptions(options.env)), { logger: false },
  );
  try {
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    const context = app.get(RADAR_HTTP_CONTEXT);
    await registerWebsocketPlugin(app);
    await configureHttpPlatform(app, context);
    await configurePageAssets(app, context);
    await configureWebsocketTransport(app, context, app.get(RealtimeService));
    configureSwagger(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  } catch (error) {
    try { await app.close(); } catch { /* preserve startup cause */ }
    throw error;
  }
}
