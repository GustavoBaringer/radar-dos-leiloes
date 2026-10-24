import {
  Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { hashOnboardingToken } from '../../../infra/notifications/onboarding-token.js';
import type { RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import {
  ONBOARDING_ACTIVATION_HTTP_SERVICE,
  type OnboardingActivationHttpService,
} from '../../services/onboarding/onboarding-activation.config.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { OnboardingActivationStartDto } from './onboarding-activation-start.dto.js';

const ACTIVATION_COOKIE = 'radar_activation';
const ACTIVATION_PATH = '/auth/onboarding/callback';
const STARTED_MESSAGE = { ok: true, message: 'Identidade vinculada. A liberação de acesso ainda não foi definida.' };
const UNAVAILABLE_MESSAGE = 'Ativação temporariamente indisponível.';
const INVALID_MESSAGE = 'Link indisponível.';
const SAFE_CALLBACK_QUERY = new Set(['code', 'state', 'iss', 'error', 'session_state']);

@Controller()
export class OnboardingActivationController {
  constructor(
    @Inject(ONBOARDING_ACTIVATION_HTTP_SERVICE) private readonly activation: OnboardingActivationHttpService | null,
    @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext,
  ) {}

  @Get('onboarding/ativacao')
  activationPage(@Res() reply: FastifyReply) {
    if (!this.activation) return reply.code(404).send();
    return reply.type('text/html; charset=utf-8').sendFile('onboarding-activation.html');
  }

  @Get('onboarding-activation.js')
  activationScript(@Res() reply: FastifyReply) {
    if (!this.activation) return reply.code(404).send();
    return reply.type('application/javascript; charset=utf-8').sendFile('onboarding-activation.js');
  }

  @Get('onboarding-activation.css')
  activationStyles(@Res() reply: FastifyReply) {
    if (!this.activation) return reply.code(404).send();
    return reply.type('text/css; charset=utf-8').sendFile('onboarding-activation.css');
  }

  @Post('api/onboarding/activation/start')
  @HttpCode(200)
  async start(
    @Body() body: OnboardingActivationStartDto,
    @Headers('origin') origin: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: RadarHttpRequest,
    @Res() reply: FastifyReply,
  ) {
    this.noStore(reply);
    const activation = this.activation;
    if (!activation) return reply.code(404).send({ error: 'not_found' });
    if (origin !== activation.config.publicOrigin) return reply.code(403).send({ error: 'invalid_origin' });
    if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }
    try {
      if (await this.limited(request)) return reply.code(429).send({ error: 'temporarily_unavailable' });
    } catch { return reply.code(503).send({ error: 'temporarily_unavailable' }); }

    let result;
    try { result = await activation.service.start(body.token); }
    catch { return reply.code(503).send({ error: 'temporarily_unavailable' }); }
    if (result.status !== 'started' || !safeAuthorizationUrl(result.authorizationUrl, activation.config.issuer)) {
      return reply.code(400).send({ error: INVALID_MESSAGE });
    }
    reply.header('set-cookie', activationCookie(result.browserToken, activation.config.cookieSecure));
    return reply.send({ authorizationUrl: result.authorizationUrl });
  }

  @Get('auth/onboarding/callback')
  async callback(@Req() request: RadarHttpRequest, @Res() reply: FastifyReply) {
    this.noStore(reply);
    const activation = this.activation;
    reply.header('set-cookie', clearActivationCookie(activation?.config.cookieSecure ?? false));
    if (!activation) return reply.code(404).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);
    try {
      if (await this.limited(request)) return reply.code(429).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);
    } catch { return reply.code(503).type('text/plain; charset=utf-8').send(UNAVAILABLE_MESSAGE); }

    const query = request.query as Record<string, unknown> | undefined;
    if (!query || Object.keys(query).some(key => !SAFE_CALLBACK_QUERY.has(key))
      || Object.values(query).some(value => typeof value !== 'string')) {
      return reply.code(400).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);
    }
    const { code, state, iss, error } = query as Record<string, string>;
    if (error || !validOpaque(state) || typeof code !== 'string' || !code || code.length > 4096
      || /[\x00-\x1f\x7f-\x9f]/.test(code) || (iss !== undefined && iss !== activation.config.issuer)) {
      return reply.code(400).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);
    }
    const browserToken = activationCookieValue(request.headers.cookie);
    if (!browserToken) return reply.code(400).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);

    let result;
    try { result = await activation.service.complete({ code, state, browserToken }); }
    catch { return reply.code(503).type('text/plain; charset=utf-8').send(UNAVAILABLE_MESSAGE); }
    if (result.status !== 'bound') return reply.code(400).type('text/plain; charset=utf-8').send(INVALID_MESSAGE);
    return reply.code(200).type('text/plain; charset=utf-8').send(STARTED_MESSAGE.message);
  }

  private noStore(reply: FastifyReply): void {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
  }

  private async limited(request: RadarHttpRequest): Promise<boolean> {
    const redis = await this.context.redisResource('signup');
    const ip = request.clientIp ?? request.ip ?? 'unknown';
    const count = await redis.incr(`activation:attempt:${ip}`);
    if (count === 1) await redis.expire(`activation:attempt:${ip}`, 3600);
    return count > 10;
  }
}

function activationCookie(token: string, secure: boolean): string {
  return `${ACTIVATION_COOKIE}=${token}; Path=/auth/onboarding; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}

function clearActivationCookie(secure: boolean): string {
  return `${ACTIVATION_COOKIE}=; Path=/auth/onboarding; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function activationCookieValue(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${ACTIVATION_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(ACTIVATION_COOKIE.length + 1);
  return validOpaque(value) ? value : null;
}

function validOpaque(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { hashOnboardingToken(value); return true; } catch { return false; }
}

function safeAuthorizationUrl(value: string, issuer: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === new URL(issuer).origin && !url.username && !url.password && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
