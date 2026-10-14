import { Body, Controller, Get, Headers, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { AuthService, type AuthOrigin, type AuthPlan } from '../../services/auth/auth.service.js';
import { AuthCallbackQueryDto, AuthLoginBodyDto, AuthQueryDto } from './auth.dto.js';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}

  private origin(req: RadarHttpRequest): AuthOrigin {
    const forwardedHeader = req.headers['x-forwarded-proto'];
    const forwardedProto = forwardedHeader == null ? undefined : String(forwardedHeader);
    return {
      protocol: req.protocol,
      host: String(req.headers.host ?? ''),
      forwardedProto,
      secure: req.protocol === 'https' || forwardedProto === 'https',
    };
  }
  private send(reply: FastifyReply, plan: AuthPlan) {
    if (plan.contentType) reply.type(plan.contentType);
    if (plan.location) reply.header('location', plan.location);
    if (plan.cookies) reply.header('set-cookie', plan.cookies);
    if (plan.status !== undefined) reply.code(plan.status);
    return plan.body === undefined ? reply.send() : reply.send(plan.body);
  }

  @Get('login') login(@Query() query: AuthQueryDto, @Res() reply: FastifyReply) {
    return this.send(reply, this.auth.loginPage({ ...query }));
  }
  @Post('api/login') async passwordLogin(@Req() req: RadarHttpRequest, @Body() body: AuthLoginBodyDto, @Res() reply: FastifyReply) {
    const plan = await this.auth.passwordLogin({ body: { ...body }, ip: req.clientIp ?? req.ip, origin: this.origin(req) });
    return this.send(reply, plan);
  }
  @Get('auth/login') async oidcLogin(@Req() req: RadarHttpRequest, @Query() query: AuthQueryDto, @Res() reply: FastifyReply) {
    return this.send(reply, await this.auth.oidcLogin({ ...query }, this.origin(req)));
  }
  @Get('auth/callback') async callback(@Req() req: RadarHttpRequest, @Query() query: AuthCallbackQueryDto, @Headers('cookie') cookie: string | undefined, @Res() reply: FastifyReply) {
    return this.send(reply, await this.auth.callback({ query: { ...query }, cookie: this.pkceCookie(cookie), origin: this.origin(req) }));
  }
  @Get('auth/logout') async logout(@Req() req: RadarHttpRequest, @Headers('cookie') cookie: string | undefined, @Res() reply: FastifyReply) {
    return this.send(reply, await this.auth.logout({ cookie, origin: this.origin(req) }));
  }

  private pkceCookie(cookie?: string): string | undefined {
    return String(cookie ?? '').split(';').map(part => part.trim().split('=')).find(([key]) => key === this.context.oidc.COOKIE_PKCE)?.[1];
  }
}
