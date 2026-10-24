import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { OnboardingCheckoutDispatcher } from './onboarding-checkout-dispatcher.js';
import type { OnboardingCheckoutEmailDispatcher } from './onboarding-checkout-email-dispatcher.js';
import type { OnboardingEmailDispatcher } from '../onboarding/onboarding-email-dispatcher.js';

const POLL_INTERVAL_MS = 5_000;
export const ONBOARDING_DISPATCH_WORKER = 'ONBOARDING_DISPATCH_WORKER';

export type OnboardingDispatchStages = {
  invitationEmail: Pick<OnboardingEmailDispatcher, 'dispatchOnce'>;
  checkout?: Pick<OnboardingCheckoutDispatcher, 'dispatchOnce'>;
  checkoutEmail?: Pick<OnboardingCheckoutEmailDispatcher, 'dispatchOnce'>;
  closeTransport?: () => void;
};

export class OnboardingDispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingDispatchWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private started = false;
  private stopping = false;

  constructor(private readonly stages: OnboardingDispatchStages) {}

  onModuleInit(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule();
  }

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const work = this.processStages();
    this.inFlight = work;
    void work.then(() => { if (this.inFlight === work) this.inFlight = undefined; }, () => { if (this.inFlight === work) this.inFlight = undefined; });
    return work;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.stages.closeTransport?.();
  }

  private schedule(): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then(() => this.schedule(), () => this.schedule());
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async processStages(): Promise<void> {
    await this.runStage('invitation/activation email dispatch', () => this.stages.invitationEmail.dispatchOnce());
    if (this.stages.checkout) await this.runStage('checkout creation', () => this.stages.checkout!.dispatchOnce());
    if (this.stages.checkoutEmail) await this.runStage('checkout payment email dispatch', () => this.stages.checkoutEmail!.dispatchOnce());
  }

  private async runStage(name: string, run: () => Promise<unknown>): Promise<void> {
    try { await run(); } catch { this.logger.warn(`Onboarding ${name} deferred; durable work retained.`); }
  }
}
