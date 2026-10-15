import { afterEach, describe, expect, it } from '@jest/globals';
import WebSocket from 'ws';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { dependencies } from '../../../scripts/fixtures/host-fixture.mjs';
import { configureHttpPlatform, radarHttpAdapterOptions } from '../../../dist/src/infra/http/http-platform.js';
import { HttpPlatformModule, RADAR_HTTP_CONTEXT } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { RealtimeModule } from '../../../dist/src/application/modules/realtime/realtime.module.js';
import { RealtimeService } from '../../../dist/src/application/services/realtime/realtime.service.js';
import { configureWebsocketTransport } from '../../../dist/src/infra/websocket/websocket-transport.adapter.js';
import { criarToken } from '../../../dist/src/infra/auth/session.js';

describe('native WebSocket realtime transport', () => {
  let app;
  let server;
  let subscriber;
  const sockets = new Set();
  let rawConnections;

  async function start() {
    const fixture = dependencies();
    const callbacks = new Map();
    subscriber = {
      status: 'wait',
      connect: async () => { subscriber.status = 'ready'; },
      on: (event, listener) => { const list = callbacks.get(event) ?? new Set(); list.add(listener); callbacks.set(event, list); return subscriber; },
      off: (event, listener) => { callbacks.get(event)?.delete(listener); return subscriber; },
      subscribe: async () => 1,
      unsubscribe: async () => 1,
      quit: async () => { subscriber.status = 'end'; return 'OK'; },
      disconnect: () => { subscriber.status = 'end'; },
      emit: (event, ...args) => { for (const listener of callbacks.get(event) ?? []) listener(...args); },
      listenerCount: (event) => callbacks.get(event)?.size ?? 0,
    };
    fixture.deps.runtime.makeRedis = () => subscriber;
    fixture.deps.identity.identidadePorSub = async (sub) => ({
      userId: sub === 'owner-b' ? 8 : sub === 'admin-a' ? 9 : 7,
      sub, email: `${sub}@private.test`, nome: sub, papel: sub === 'admin-a' ? 'admin' : 'comum',
    });
    const env = { NODE_ENV: 'test' };
    const paths = { projectRoot: process.cwd(), webRoot: `${process.cwd()}/web`, appDist: '', certDir: '', dataDir: '' };
    class AppModule {}
    Module({ imports: [HttpPlatformModule.forRoot({ env, paths, dependencies: fixture.deps }), RealtimeModule] })(AppModule);
    app = await NestFactory.create(AppModule, new FastifyAdapter(radarHttpAdapterOptions(env)), { logger: false });
    const context = app.get(RADAR_HTTP_CONTEXT);
    const realtime = app.get(RealtimeService);
    await configureHttpPlatform(app, context);
    await configureWebsocketTransport(app, context, realtime);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    rawConnections = new Set();
    app.getHttpServer().on('connection', (socket) => { rawConnections.add(socket); socket.on('close', () => rawConnections.delete(socket)); });
    const address = app.getHttpServer().address();
    server = `ws://127.0.0.1:${address.port}/ws`;
    return realtime;
  }

  function connect(token) {
    const socket = new WebSocket(server, token ? { headers: { Cookie: `radar_sessao=${token}` } } : {});
    sockets.add(socket);
    return socket;
  }
  function opened(socket) {
    return new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
      socket.once('error', reject);
    });
  }
  function nextMessage(socket) {
    return new Promise((resolve, reject) => {
      socket.once('message', (data) => { try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); } });
      socket.once('error', reject);
    });
  }
  async function noMessage(socket, ms = 80) {
    let received = false;
    const onMessage = () => { received = true; };
    socket.on('message', onMessage);
    await new Promise((resolve) => setTimeout(resolve, ms));
    socket.off('message', onMessage);
    expect(received).toBe(false);
  }
  async function closeSocket(socket) {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 500);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
    });
  }
  afterEach(async () => {
    await Promise.all([...sockets].map(closeSocket)); sockets.clear();
    if (app) await app.get(RealtimeService).onModuleDestroy();
    const fastify = app?.getHttpAdapter().getInstance();
    for (const socket of fastify?.websocketServer?.clients ?? []) socket.terminate();
    for (const socket of rawConnections ?? []) socket.destroy();
    await app?.close(); app = undefined;
  }, 30_000);

  it('denies anonymous upgrades and sends hello only after authenticated account admission', async () => {
    const realtime = await start();
    const anonymous = connect();
    expect(await opened(anonymous)).toBe(401);
    expect(realtime.clientCount).toBe(0);
    const user = connect(criarToken('comum', 'owner-a'));
    const hello = nextMessage(user);
    await opened(user);
    expect(await hello).toEqual({ type: 'hello', ts: expect.any(Number) });
    expect(realtime.clientCount).toBe(1);
    await closeSocket(user);
    expect(realtime.clientCount).toBe(0);
  }, 30_000);

  it('filters admin events and alerts by owner, strips private fields, and ignores malformed pubsub JSON', async () => {
    await start();
    const ownerA = connect(criarToken('comum', 'owner-a'));
    const ownerB = connect(criarToken('comum', 'owner-b'));
    const admin = connect(criarToken('admin', 'admin-a'));
    const hellos = [nextMessage(ownerA), nextMessage(ownerB), nextMessage(admin)];
    await Promise.all([opened(ownerA), opened(ownerB), opened(admin)]);
    await Promise.all(hellos);

    const collect = JSON.stringify({ type: 'collect', detail: 'private admin event' });
    const adminResult = nextMessage(admin);
    subscriber.emit('message', 'lot-updates', collect);
    expect(await adminResult).toEqual({ type: 'collect', detail: 'private admin event' });
    await noMessage(ownerA);
    await noMessage(ownerB);

    const alertA = nextMessage(ownerA);
    const alertB = nextMessage(ownerB);
    subscriber.emit('message', 'lot-updates', JSON.stringify({ type: 'alertas', disparos: [
      { ownerId: 7, email: 'secret-a@test', alertId: 1, label: 'a', lotId: 11, title: 'first', lotUrl: '/a', bid: 10, source: 's' },
      { ownerId: 8, email: 'secret-b@test', alertId: 2, label: 'b', lotId: 12, title: 'second', lotUrl: '/b', bid: 20, source: 's' },
    ] }));
    const receivedA = await alertA;
    const receivedB = await alertB;
    expect(receivedA.disparos).toEqual([{ alertId: 1, label: 'a', lotId: 11, title: 'first', lotUrl: '/a', bid: 10, source: 's' }]);
    expect(receivedB.disparos).toEqual([{ alertId: 2, label: 'b', lotId: 12, title: 'second', lotUrl: '/b', bid: 20, source: 's' }]);
    expect(JSON.stringify([receivedA, receivedB])).not.toMatch(/email|ownerId|secret-/);
    await noMessage(admin);
    ownerA.send('{invalid client message');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ownerA.readyState).toBe(WebSocket.OPEN);
    subscriber.emit('message', 'lot-updates', '{invalid');
    await noMessage(ownerA);
    expect(subscriber.listenerCount('message')).toBe(1);
    await app.get(RealtimeService).onModuleDestroy();
    expect(subscriber.listenerCount('message')).toBe(0);
    expect(subscriber.listenerCount('error')).toBe(0);
  }, 30_000);
});
