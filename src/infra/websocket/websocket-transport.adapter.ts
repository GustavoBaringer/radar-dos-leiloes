import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { admitWsUpgrade, attachWsUpgrade } from './ws-admission.js';
import type { WsReservation, WsSocket } from '../../application/security/ws-protection.js';
import type { RadarHttpContext, RadarHttpRequest } from '../http/radar-http-context.js';
import type { RealtimeService } from '../../application/services/realtime/realtime.service.js';

interface WsRequest extends FastifyRequest {
  ws: boolean;
  eu?: RadarHttpRequest['eu'];
  papel?: RadarHttpRequest['papel'];
  wsReservation?: WsReservation;
  wsAdmissionCleanup?: () => void;
}

class FastifyRealtimePeer {
  constructor(private readonly socket: WsSocket, private readonly service: RealtimeService) {}
  get bufferedAmount() { return this.socket.bufferedAmount; }
  send(data: string): boolean {
    const protection = this.service.protectionEngine;
    return protection ? protection.safeSend(this.socket, data) : false;
  }
  close() { try { this.socket.close(1008, 'unauthorized'); } catch { this.socket.terminate?.(); } }
}

/** WebSocket is the deliberate transport-only exception to native Nest HTTP routes. */
export async function configureWebsocketTransport(
  app: NestFastifyApplication,
  _context: RadarHttpContext,
  service: RealtimeService,
): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  await fastify.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  fastify.get('/ws', {
    websocket: true,
    preHandler: async (request: WsRequest, reply: FastifyReply) => {
      if (!request.ws) return;
      const protection = service.protectionEngine;
      if (!protection) return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'overloaded', retryAfterSeconds: 1 });
      await admitWsUpgrade(request, reply, {
        protection,
        // The global platform post-auth hook has already enforced wsAccount on this route.
        checkAccount: async () => ({ allowed: true }),
        sendUnauthenticated: (res) => res.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized' }),
        sendRateLimit: (res, decision) => {
          if (decision.allowed) return false;
          const seconds = Math.max(1, Number(decision.retryAfterSeconds) || 1);
          res.code(429).header('Retry-After', String(seconds)).header('Cache-Control', 'no-store')
            .send({ error: 'rate_limited', retryAfterSeconds: seconds });
          return true;
        },
      });
    },
  }, (socket, request: WsRequest) => {
    if (!attachWsUpgrade(request, socket as unknown as WsSocket, service.protectionEngine!)) return;
    const peer = new FastifyRealtimePeer(socket as unknown as WsSocket, service);
    const actor = request.eu && request.papel ? { userId: request.eu.userId, papel: request.papel } : undefined;
    if (!service.connect(actor, peer)) return;
    const cleanup = () => {
      service.disconnect(peer);
      socket.off('close', cleanup);
      socket.off('error', cleanup);
      socket.off('message', ignoreIncoming);
    };
    const ignoreIncoming = () => {};
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', ignoreIncoming);
  });
}
