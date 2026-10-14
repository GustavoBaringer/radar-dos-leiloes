import { afterEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createNestApplication } from '../../../dist/src/main.js';

describe('health e2e', () => {
  let app;

  afterEach(async () => {
    await app?.close();
  });

  it('serves health, rejects an invalid DTO query, and exposes OpenAPI', async () => {
    app = await createNestApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const server = app.getHttpServer();

    const healthy = await request(server).get('/health');
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ status: 'ok' });
    expect((await request(server).get('/health?verbose=not-a-boolean')).status).toBe(400);
    const openapi = await request(server).get('/api/docs-json');
    expect(openapi.status).toBe(200);
    expect(openapi.body.paths['/health']).toBeDefined();
  }, 30_000);
});
