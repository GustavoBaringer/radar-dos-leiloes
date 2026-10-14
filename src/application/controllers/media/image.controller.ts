import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { imageRequestSignal } from '../../../infra/media/image-request.adapter.js';
import { ImageProxyService } from '../../services/media/image-proxy.service.js';

@Controller()
export class ImageController {
  constructor(private readonly images: ImageProxyService) {}

  @Get('/api/img')
  async get(@Req() request: RadarHttpRequest, @Res() reply: FastifyReply) {
    const query = request.query as Record<string, unknown>;
    if (Array.isArray(query.u) || Array.isArray(query.w) || (query.u !== undefined && typeof query.u !== 'string')
      || (query.w !== undefined && typeof query.w !== 'string')) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_image_request' });
    }
    const url = query.u as string | undefined;
    const width = query.w as string | undefined;
    if ((url && url.length > 4096) || (width !== undefined && !/^\d+$/.test(width))) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_image_request' });
    }

    let cache: unknown;
    let placeholder = false;
    const started = this.images.startTelemetry(request.clientIp ?? request.ip ?? '');
    const abort = imageRequestSignal(request, reply);
    try {
      const result = await this.images.get({ url, width: width === undefined ? null : Number(width) }, abort.signal,
        (value) => { cache = value; reply.header('x-cache', value); });
      const outcome = result.outcome;
      if (outcome.kind === 'image') {
        reply.header('content-type', outcome.contentType).header('cache-control', 'public, max-age=86400')
          .header('x-cache', outcome.cache);
        cache = outcome.cache;
        return reply.send(outcome.buffer);
      }
      if (outcome.kind === 'overload') return reply.code(503).header('Retry-After', '1').header('Cache-Control', 'no-store')
        .send({ error: 'overloaded', retryAfterSeconds: 1 });
      if (outcome.kind === 'source-failure') return reply.code(503).header('Cache-Control', 'no-store').send();
      placeholder = true;
      return reply.code(200).header('content-type', 'image/svg+xml; charset=utf-8').header('cache-control', 'public, max-age=300')
        .header('x-nopic-motivo', outcome.reason).send(result.placeholder);
    } finally {
      abort.close();
      this.images.completeTelemetry(started, reply.statusCode, cache, placeholder);
    }
  }
}
