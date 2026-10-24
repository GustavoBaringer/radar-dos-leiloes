import { Module } from '@nestjs/common';
import { AccountsController } from '../../controllers/accounts/accounts.controller.js';
import { OnboardingController } from '../../controllers/onboarding/onboarding.controller.js';
import { AccountsRepository, ACCOUNTS_QUERY } from '../../../infra/database/repositories/accounts.repository.js';
import { OnboardingRepository } from '../../../infra/database/repositories/onboarding.repository.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { ALERT_CANDIDATE_COUNTER, ACCOUNTS_RUNTIME_CONFIG, AccountsService, REGISTRATION_THROTTLE } from '../../services/accounts/accounts.service.js';
import { loadOnboardingRuntimeConfig, ONBOARDING_SERVICE, OnboardingService } from '../../services/onboarding/onboarding.service.js';

@Module({
  controllers: [AccountsController, OnboardingController],
  providers: [
    AccountsRepository,
    { provide: ACCOUNTS_QUERY, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => context.data.query },
    { provide: ALERT_CANDIDATE_COUNTER, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => context.data.contarCasaveis },
    { provide: ACCOUNTS_RUNTIME_CONFIG, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => ({
      publicKey: context.env.VAPID_PUBLIC?.trim() || null,
      pushAvailable: Boolean(context.env.VAPID_PUBLIC?.trim() && context.env.VAPID_PRIVATE?.trim()),
      emailAvailable: Boolean(context.env.SMTP_HOST?.trim()),
      registrationThrottleEnabled: context.env.ANTIBOT_MODE !== 'enforce',
    }) },
    { provide: REGISTRATION_THROTTLE, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => ({
      consume: async (ip: string) => {
        const redis = await context.redisResource('signup');
        const key = `cadastro:tentativa:${ip}`;
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, 3600);
        return n > 10;
      },
    }) },
    { provide: ONBOARDING_SERVICE, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => {
      const config = loadOnboardingRuntimeConfig(context.env);
      if (!config) return null;
      return new OnboardingService(new OnboardingRepository(PrismaService.getInstance()), config);
    } },
    AccountsService,
  ],
})
export class AccountsModule {}
