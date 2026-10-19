import { Controller, Get, Headers, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { radarActorFromRequest, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { PlatformSecurityService } from '../../services/platform/security.service.js';

@Controller()
export class PlatformSecurityController {
  constructor(private readonly security: PlatformSecurityService) {}
  @Get('/api/security-config') config(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    return this.security.clientConfig();
  }
  @Get('/api/security/metrics') metrics(@Req() request: RadarHttpRequest, @Res() reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    try { return reply.send(this.security.metrics(radarActorFromRequest(request))); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401) return reply.code(401).send({ error: 'unauthorized' });
      if (status === 403) return reply.code(403).send({ error: 'forbidden' });
      throw error;
    }
  }
}
