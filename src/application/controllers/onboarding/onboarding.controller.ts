import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, Inject, NotFoundException, Post, Req, Res, ServiceUnavailableException, UnsupportedMediaTypeException, UsePipes, ValidationPipe } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ONBOARDING_SERVICE, OnboardingService } from '../../services/onboarding/onboarding.service.js';
import { REGISTRATION_THROTTLE, type RegistrationThrottle } from '../../services/accounts/accounts.service.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { OnboardingConfirmDto } from './onboarding-confirm.dto.js';

const CONFIRM_MESSAGE = 'Solicitação recebida. Se o convite for válido, você receberá os próximos passos por e-mail.';

@Controller()
export class OnboardingController {
  constructor(
    @Inject(ONBOARDING_SERVICE) private readonly onboarding: OnboardingService | null,
    @Inject(REGISTRATION_THROTTLE) private readonly throttle: RegistrationThrottle,
    @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext,
  ) {}

  private enabled() {
    return this.onboarding != null && this.context.env.ONBOARDING_ENABLED === 'true';
  }

  @Get('onboarding/convite')
  invitationPage(@Res() reply: FastifyReply) {
    if (!this.enabled()) throw new NotFoundException();
    return reply.sendFile('onboarding-invitation.html');
  }

  @Post('api/onboarding/invitations/confirm')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async confirm(
    @Body() body: OnboardingConfirmDto,
    @Headers('origin') origin: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: RadarHttpRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const onboarding = this.onboarding;
    if (!this.enabled() || !onboarding) throw new NotFoundException();
    const publicBaseUrl = this.context.env.ONBOARDING_PUBLIC_BASE_URL;
    let publicOrigin: string;
    try { publicOrigin = new URL(publicBaseUrl ?? '').origin; }
    catch { throw new NotFoundException(); }
    if (origin !== publicOrigin) throw new ForbiddenException();
    if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      throw new UnsupportedMediaTypeException();
    }

    let limited: boolean;
    try {
      limited = await this.throttle.consume(request.clientIp ?? '');
    } catch {
      throw new ServiceUnavailableException('Confirmação temporariamente indisponível.');
    }
    if (limited) throw new HttpException('Muitas tentativas. Tente novamente em alguns minutos.', 429);
    try {
      await onboarding.consumeInvitationToken(body.token ?? '');
    } catch {
      throw new ServiceUnavailableException('Confirmação temporariamente indisponível.');
    }
    return { ok: true, message: CONFIRM_MESSAGE };
  }
}
