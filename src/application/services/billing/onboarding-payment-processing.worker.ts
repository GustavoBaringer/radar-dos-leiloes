import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AsaasSandboxClient } from '../../../infra/billing/asaas-sandbox.client.js';
import type { OnboardingPaymentProcessingRepository } from '../../../infra/database/repositories/onboarding-payment-processing.repository.js';
import type { OnboardingPaidPaymentCoordinator } from './onboarding-paid-payment-coordinator.js';
import { loadAsaasWebhookConfig } from './asaas-webhook.service.js';
import { loadOnboardingActivationHttpConfig } from '../onboarding/onboarding-activation.config.js';
import { loadOnboardingRuntimeConfig } from '../onboarding/onboarding.service.js';

const POLL_INTERVAL_MS = 5_000;
export const ONBOARDING_PAYMENT_PROCESSING_WORKER = 'ONBOARDING_PAYMENT_PROCESSING_WORKER';

export type OnboardingPaymentProcessingConfig = {
  allowedEmails: readonly string[];
  tokenKey: Buffer;
  apiKey: string;
  issuer: string;
};

export function loadOnboardingPaymentProcessingConfig(env: NodeJS.ProcessEnv): OnboardingPaymentProcessingConfig | null {
  if (env.ASAAS_PAYMENT_PROCESSING_ENABLED !== 'true') return null;
  try {
    const onboarding = loadOnboardingRuntimeConfig(env);
    const activation = loadOnboardingActivationHttpConfig(env);
    const webhook = loadAsaasWebhookConfig(env);
    const apiKey = env.ASAAS_API_KEY;
    if (!onboarding || !activation || !webhook || !apiKey) throw new Error('invalid');
    new AsaasSandboxClient(apiKey);
    return {
      allowedEmails: [...onboarding.allowedEmails],
      tokenKey: Buffer.from(onboarding.tokenKey),
      apiKey,
      issuer: activation.issuer,
    };
  } catch {
    throw new Error('Invalid onboarding payment processing configuration.');
  }
}

export class OnboardingPaymentProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingPaymentProcessingWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private started = false;
  private stopping = false;

  constructor(
    private readonly repository: Pick<OnboardingPaymentProcessingRepository, 'takeBatch'>,
    private readonly coordinator: Pick<OnboardingPaidPaymentCoordinator, 'process'>,
  ) {}

  onModuleInit(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule();
  }

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const work = this.processOne();
    this.inFlight = work;
    void work.then(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    }, () => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    return work;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then(() => this.schedule(), () => this.schedule());
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async processOne(): Promise<void> {
    try {
      // ponytail: process one event per five-second cycle; raise the bounded batch if staging throughput requires it.
      const [event] = await this.repository.takeBatch(1);
      if (event) await this.coordinator.process(event.eventId);
    } catch {
      this.logger.warn('Onboarding payment processing deferred; durable inbox retained.');
    }
  }
}
