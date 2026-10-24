import { Module } from '@nestjs/common';
import { AsaasWebhookController } from '../../controllers/billing/asaas-webhook.controller.js';
import { ASAAS_WEBHOOK_SERVICE, AsaasWebhookService, loadAsaasWebhookConfig } from '../../services/billing/asaas-webhook.service.js';
import { AsaasWebhookInboxRepository } from '../../../infra/database/repositories/asaas-webhook-inbox.repository.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { AsaasSandboxClient } from '../../../infra/billing/asaas-sandbox.client.js';
import { OnboardingPaidAccessRepository } from '../../../infra/database/repositories/onboarding-paid-access.repository.js';
import { OnboardingPaymentProcessingRepository } from '../../../infra/database/repositories/onboarding-payment-processing.repository.js';
import { OnboardingPaymentRepository } from '../../../infra/database/repositories/onboarding-payment.repository.js';
import { OnboardingPaymentReconciler } from '../../services/billing/onboarding-payment-reconciler.js';
import { OnboardingPaidPaymentCoordinator } from '../../services/billing/onboarding-paid-payment-coordinator.js';
import {
  loadOnboardingPaymentProcessingConfig,
  OnboardingPaymentProcessingWorker,
  ONBOARDING_PAYMENT_PROCESSING_WORKER,
} from '../../services/billing/onboarding-payment-processing.worker.js';
import { loadOnboardingDispatchConfig } from '../../services/billing/onboarding-dispatch.config.js';
import { OnboardingDispatchWorker, ONBOARDING_DISPATCH_WORKER } from '../../services/billing/onboarding-dispatch.worker.js';
import { OnboardingEmailDispatcher } from '../../services/onboarding/onboarding-email-dispatcher.js';
import { OnboardingCheckoutDispatcher } from '../../services/billing/onboarding-checkout-dispatcher.js';
import { OnboardingCheckoutEmailDispatcher } from '../../services/billing/onboarding-checkout-email-dispatcher.js';
import { OnboardingEmailRepository } from '../../../infra/database/repositories/onboarding-email.repository.js';
import { OnboardingCheckoutRepository } from '../../../infra/database/repositories/onboarding-checkout.repository.js';
import { criarTransporteSmtp } from '../../../infra/notifications/smtp.adapter.js';

@Module({
  controllers: [AsaasWebhookController],
  providers: [{
    provide: ASAAS_WEBHOOK_SERVICE,
    inject: [RadarHttpContext],
    useFactory: (context: RadarHttpContext) => {
      const config = loadAsaasWebhookConfig(context.env);
      return config ? new AsaasWebhookService(config, new AsaasWebhookInboxRepository(PrismaService.getInstance())) : null;
    },
  }, { provide: AsaasWebhookService, useExisting: ASAAS_WEBHOOK_SERVICE }, {
    provide: ONBOARDING_PAYMENT_PROCESSING_WORKER,
    inject: [RadarHttpContext],
    useFactory: async (context: RadarHttpContext) => {
      const config = loadOnboardingPaymentProcessingConfig(context.env);
      if (!config) return null;
      await context.assertOnboardingAdmission();
      const admission = context.dependencies.onboardingAdmission;
      if (!admission) throw new Error('Staging admission policy is unavailable.');
      await admission.assertInitialized(config.issuer);

      const prisma = PrismaService.getInstance();
      const client = new AsaasSandboxClient(config.apiKey);
      const processing = new OnboardingPaymentProcessingRepository(config.allowedEmails, prisma);
      const reconciler = new OnboardingPaymentReconciler(
        new OnboardingPaymentRepository(config.allowedEmails, prisma), client, { tokenKey: config.tokenKey },
      );
      const paidAccess = new OnboardingPaidAccessRepository(config.allowedEmails, prisma);
      const coordinator = new OnboardingPaidPaymentCoordinator(processing, reconciler, paidAccess, client);
      return new OnboardingPaymentProcessingWorker(processing, coordinator);
    },
  }, {
    provide: ONBOARDING_DISPATCH_WORKER,
    inject: [RadarHttpContext],
    useFactory: async (context: RadarHttpContext) => {
      const config = loadOnboardingDispatchConfig(context.env);
      if (!config) return null;
      await context.assertOnboardingAdmission();
      const admission = context.dependencies.onboardingAdmission;
      const issuer = context.env.OIDC_ISSUER?.trim();
      if (!admission || !issuer) throw new Error('Staging admission policy is unavailable.');
      await admission.assertInitialized(issuer);

      const prisma = PrismaService.getInstance();
      const emailRepository = new OnboardingEmailRepository(prisma);
      const checkoutRepository = new OnboardingCheckoutRepository(prisma);
      const mailer = await criarTransporteSmtp(context.env);
      const invitationEmail = new OnboardingEmailDispatcher(
        emailRepository, mailer, config.onboarding, config.from, () => new Date(), { activationEnabled: config.activationEnabled },
      );
      const checkout = config.checkoutEnabled
        ? new OnboardingCheckoutDispatcher(checkoutRepository, new AsaasSandboxClient(config.apiKey!),
          [...config.onboarding.allowedEmails], config.checkoutReturnUrl!)
        : undefined;
      const checkoutEmail = config.checkoutEmailEnabled
        ? new OnboardingCheckoutEmailDispatcher(checkoutRepository, mailer, config.onboarding, config.from)
        : undefined;
      return new OnboardingDispatchWorker({ invitationEmail, checkout, checkoutEmail, closeTransport: () => mailer.close() });
    },
  }],
})
export class BillingModule {}
