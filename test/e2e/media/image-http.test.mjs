import { afterEach, describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import request from 'supertest';
import sharp from 'sharp';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { dependencies } from '../../../scripts/fixtures/host-fixture.mjs';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { MediaModule } from '../../../dist/src/application/modules/media/media.module.js';
import { imageRequestSignal } from '../../../dist/src/infra/media/image-request.adapter.js';

describe('native image proxy route', () => {
  let app;
  let state;
  let upstreamCalls;
  async function start() {
    const fixture = dependencies();
    state = fixture.state;
    const query = fixture.deps.data.query;
    fixture.deps.data.query = async (sql, params) => sql.includes('jsonb_array_elements_text(photos)')
      ? (state.queries.push(sql), [{ host: 'images.example.test', n: 1 }])
      : query(sql, params);
    upstreamCalls = [];
    const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#123456' } }).png().toBuffer();
    const imageRequest = async (url, options) => {
      upstreamCalls.push({ url, options });
      return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Readable.from([png]) };
    };
    const env = { NODE_ENV: 'test' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class AppModule {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), MediaModule.forRoot({ request: imageRequest })] })(AppModule);
    app = await NestFactory.create(AppModule, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    const context = app.get(RADAR_HTTP_CONTEXT);
    await configureHttpPlatform(app, context);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app.getHttpServer();
  }
  afterEach(async () => { await app?.close(); app = undefined; });

  it('serves public allowlisted raster bytes, caches hits, and records image telemetry', async () => {
    const server = await start();
    const url = 'https://images.example.test/photo.png';
    const first = await request(server).get('/api/img').query({ u: url });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^image\/png/);
    expect(first.headers['x-cache']).toBe('miss');
    expect(first.body.length).toBeGreaterThan(0);
    expect(upstreamCalls).toHaveLength(1);
    const cached = await request(server).get('/api/img').query({ u: url });
    expect(cached.status).toBe(200);
    expect(cached.headers['x-cache']).toBe('hit');
    expect(upstreamCalls).toHaveLength(1);
    const context = app.get(RADAR_HTTP_CONTEXT);
    expect(context.imageTelemetry.snapshot().total.requests).toBe(2);
    expect(context.imageTelemetry.snapshot().total.cacheMisses).toBe(1);
    expect(context.imageTelemetry.snapshot().total.cacheHits).toBe(1);
    expect(state.queries.some((sql) => sql.includes('jsonb_array_elements_text(photos)'))).toBe(true);
  });

  it('returns legacy placeholder for blocked hosts and 400 for malformed query', async () => {
    const server = await start();
    const blocked = await request(server).get('/api/img').query({ u: 'https://169.254.169.254/latest/meta-data' });
    expect(blocked.status).toBe(200);
    expect(blocked.headers['x-nopic-motivo']).toBe('host-not-allowed');
    expect(blocked.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(upstreamCalls).toHaveLength(0);
    const invalid = await request(server).get('/api/img').query({ u: 'https://images.example.test/a', w: 'abc' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid_image_request' });
    expect(upstreamCalls).toHaveLength(0);
  });

  it('rejects an allowlisted cache miss when platform admission explicitly denies work', async () => {
    const server = await start();
    app.get(RADAR_HTTP_CONTEXT).setReadAdmission(() => null);
    const response = await request(server).get('/api/img').query({ u: 'https://images.example.test/denied.png' });
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'overloaded', retryAfterSeconds: 1 });
    expect(upstreamCalls).toHaveLength(0);
  });

  it('removes abort-adapter listeners when request handling finishes', () => {
    const rawRequest = new EventEmitter();
    const rawReply = new EventEmitter();
    rawReply.writableFinished = true;
    const adapter = imageRequestSignal({ raw: rawRequest }, { raw: rawReply });
    expect(rawRequest.listenerCount('aborted')).toBe(1);
    expect(rawReply.listenerCount('close')).toBe(1);
    adapter.close();
    expect(rawRequest.listenerCount('aborted')).toBe(0);
    expect(rawReply.listenerCount('close')).toBe(0);
  });
});
