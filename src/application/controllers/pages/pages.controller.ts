import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { radarActorFromRequest, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { PagesService, type PagePlan } from '../../services/pages/pages.service.js';

@ApiTags('pages')
@Controller()
export class PagesController {
  constructor(private readonly pages: PagesService, @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}

  private send(reply: FastifyReply, plan: PagePlan) {
    if (plan.contentType) reply.type(plan.contentType);
    for (const [name, value] of Object.entries(plan.headers ?? {})) reply.header(name, value);
    if (plan.location) reply.header('location', plan.location);
    if (plan.status !== undefined) reply.code(plan.status);
    return reply.send(plan.body);
  }
  private request(req: RadarHttpRequest) {
    return {
      protocol: req.protocol, host: String(req.headers.host ?? ''),
      forwardedHost: req.headers['x-forwarded-host'] == null ? undefined : String(req.headers['x-forwarded-host']),
      forwardedProto: req.headers['x-forwarded-proto'] == null ? undefined : String(req.headers['x-forwarded-proto']),
      userAgent: String(req.headers['user-agent'] ?? ''),
    };
  }

  @Get() root(@Res() reply: FastifyReply) { return this.send(reply, this.pages.landing()); }
  @Get('busca') busca(@Res() reply: FastifyReply) { return this.send(reply, this.pages.spa()); }
  @Get('alertas') alertas(@Res() reply: FastifyReply) { return this.send(reply, this.pages.spa()); }
  @Get('favoritos') favoritos(@Res() reply: FastifyReply) { return this.send(reply, this.pages.spa()); }
  @Get('cobertura') cobertura(@Res() reply: FastifyReply) { return this.send(reply, this.pages.spa()); }
  @Get('lote/:slug') async lot(@Req() req: RadarHttpRequest, @Param('slug') slug: string, @Res() reply: FastifyReply) {
    const plan = await this.context.runRead(() => this.pages.lot(slug, radarActorFromRequest(req)?.eu, this.request(req)));
    return this.send(reply, plan);
  }
  @Get('robots.txt') robots(@Res() reply: FastifyReply) { return this.send(reply, this.pages.robots()); }
  @Get('sitemap.xml') sitemap(@Res() reply: FastifyReply) { return this.send(reply, this.pages.sitemap()); }
  @Get('ca.crt') certificate(@Res() reply: FastifyReply) { return this.send(reply, this.pages.certificate()); }
}
