import { emailValido } from '../../../domain/identity/cadastro.js';
import type { OnboardingRuntimeConfig } from '../onboarding/onboarding.service.js';
import type { OnboardingCheckoutRepository, CheckoutEmailLease } from '../../../infra/database/repositories/onboarding-checkout.repository.js';
import { renderCheckoutPaymentEmail } from '../../../infra/notifications/onboarding-email.templates.js';
import type { EmailMessage } from '../../../infra/notifications/smtp.adapter.js';
import type { OnboardingMailTransport, OnboardingDispatchSummary } from '../onboarding/onboarding-email-dispatcher.js';

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

export class OnboardingCheckoutEmailDispatcher {
  private readonly baseUrl: URL;

  constructor(
    private readonly repository: OnboardingCheckoutRepository,
    private readonly mailer: OnboardingMailTransport,
    private readonly config: OnboardingRuntimeConfig,
    private readonly from: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.baseUrl = new URL(config.publicBaseUrl);
    if (this.baseUrl.protocol !== 'https:' || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash || this.baseUrl.pathname !== '/') throw new Error('Invalid checkout email base URL.');
    if (!from || /[\r\n]/.test(from)) throw new Error('Invalid checkout email sender.');
  }

  async dispatchOnce(): Promise<OnboardingDispatchSummary> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const lease = await this.repository.claimCheckoutEmail([...this.config.allowedEmails], now, leaseUntil);
    const summary: OnboardingDispatchSummary = { claimed: lease ? 1 : 0, sent: 0, retried: 0, paused: 0, cleared: 0, leaseLost: 0 };
    if (lease) await this.deliver(lease, summary);
    return summary;
  }

  private async deliver(lease: CheckoutEmailLease, summary: OnboardingDispatchSummary): Promise<void> {
    const recipient = lease.recipient?.trim().toLowerCase() ?? '';
    let parsed: URL;
    try { parsed = new URL(lease.checkoutLink); } catch { await this.pause(lease, 'invalid_checkout_link', summary); return; }
    if (lease.attempts > MAX_ATTEMPTS || !recipient || !emailValido(recipient)
      || !this.config.allowedEmails.has(recipient) || /[\u0000-\u001f\u007f-\u009f]/.test(lease.checkoutLink)
      || lease.checkoutLink.length > 2048 || parsed.origin !== 'https://sandbox.asaas.com'
      || parsed.username || parsed.password
      || (lease.name ?? '').length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(lease.name ?? '')) {
      await this.pause(lease, 'invalid_checkout_email_data', summary); return;
    }
    const now = this.clock();
    if (!await this.repository.checkoutEmailLeaseCurrent(lease, now)) { summary.leaseLost++; return; }
    const rendered = renderCheckoutPaymentEmail({ name: lease.name ?? '', url: lease.checkoutLink });
    const message: EmailMessage & { messageId: string } = {
      from: this.from, to: recipient, ...rendered,
      messageId: `<checkout-payment-${lease.id}@${this.baseUrl.hostname}>`,
    };
    try {
      await this.mailer.sendMail(message);
    } catch {
      const failedAt = this.clock();
      const retryAt = new Date(failedAt.getTime() + Math.min(30_000 * 2 ** Math.max(0, lease.attempts - 1), 6 * 60 * 60_000));
      if (lease.attempts >= MAX_ATTEMPTS) {
        if (await this.repository.pauseCheckoutEmail(lease, 'smtp_retry_limit')) summary.paused++;
        else summary.leaseLost++;
      } else if (await this.repository.retryCheckoutEmail(lease, retryAt, 'smtp_failure')) summary.retried++;
      else summary.leaseLost++;
      return;
    }
    if (await this.repository.markCheckoutEmailSent(lease, this.clock())) summary.sent++;
    else summary.leaseLost++;
  }

  private async pause(lease: CheckoutEmailLease, code: string, summary: OnboardingDispatchSummary): Promise<void> {
    if (await this.repository.pauseCheckoutEmail(lease, code)) summary.paused++;
    else summary.leaseLost++;
  }
}
