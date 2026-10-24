import { Module } from '@nestjs/common';
import { OnboardingActivationController } from '../../controllers/onboarding-activation/onboarding-activation.controller.js';
import { OnboardingActivationRepository } from '../../../infra/database/repositories/onboarding-activation.repository.js';
import { OnboardingActivationService } from '../../services/onboarding/onboarding-activation.service.js';
import { ONBOARDING_ACTIVATION_HTTP_SERVICE, loadOnboardingActivationHttpConfig } from '../../services/onboarding/onboarding-activation.config.js';
import type { OnboardingActivationHttpService } from '../../services/onboarding/onboarding-activation.config.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';

@Module({
  controllers: [OnboardingActivationController],
  providers: [{
    provide: ONBOARDING_ACTIVATION_HTTP_SERVICE,
    inject: [RadarHttpContext],
    useFactory: (context: RadarHttpContext): OnboardingActivationHttpService | null => {
      const config = loadOnboardingActivationHttpConfig(context.env);
      if (!config) return null;
      const prepare = context.oidc.prepareActivationAuthorization;
      const complete = context.oidc.completeActivationAuthorization;
      if (!prepare || !complete) throw new Error('Activation OIDC adapter is unavailable.');
      const repository = new OnboardingActivationRepository({
        allowedEmails: [...config.allowedEmails], issuer: config.issuer, clientId: config.clientId, redirectUri: config.redirectUri,
      });
      const service = new OnboardingActivationService(repository, {
        prepareActivationAuthorization: prepare,
        completeActivationAuthorization: complete,
      }, config);
      return { service, config };
    },
  }],
  exports: [ONBOARDING_ACTIVATION_HTTP_SERVICE],
})
export class OnboardingActivationModule {}
