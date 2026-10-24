import { emailValido } from '../../../domain/identity/cadastro.js';
import type { OnboardingRuntimeConfig } from './onboarding.service.js';
import { decryptOnboardingToken, hashOnboardingToken } from '../../../infra/notifications/onboarding-token.js';
import { renderActivationInvitation, renderCheckoutInvitation } from '../../../infra/notifications/onboarding-email.templates.js';
import type { EmailMessage } from '../../../infra/notifications/smtp.adapter.js';
import type {
  OnboardingEmailLease,
  OnboardingEmailRepository,
  OnboardingEmailRepairReason,
  OnboardingEmailTerminalReason,
} from '../../../infra/database/repositories/onboarding-email.repository.js';

const LEASE_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OnboardingMailTransport = { sendMail(message: EmailMessage): Promise<unknown> };

export type OnboardingDispatchSummary = {
  claimed: number;
  sent: number;
  retried: number;
  paused: number;
  cleared: number;
  leaseLost: number;
};

function retryDelay(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

export class OnboardingEmailDispatcher {
  private readonly baseUrl: URL;
  private readonly activationEnabled: boolean;

  constructor(
    private readonly repository: Pick<OnboardingEmailRepository,
      'claimPending' | 'leaseIsCurrent' | 'markSent' | 'scheduleRetry' | 'pauseForRepair' | 'clearExpiredOrConsumed'>,
    private readonly mailer: OnboardingMailTransport,
    private readonly config: OnboardingRuntimeConfig,
    private readonly from: string,
    private readonly clock: () => Date = () => new Date(),
    options: { activationEnabled?: boolean } = {},
  ) {
    this.activationEnabled = options.activationEnabled === true;
    this.baseUrl = new URL(config.publicBaseUrl);
    if (this.baseUrl.protocol !== 'https:' || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash || this.baseUrl.pathname !== '/') {
      throw new Error('Onboarding email delivery requires an HTTPS staging base URL.');
    }
    if (!from || /[\r\n]/.test(from)) throw new Error('Onboarding email sender configuration is invalid.');
  }

  async dispatchOnce(): Promise<OnboardingDispatchSummary> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const leases = this.activationEnabled
      ? await this.repository.claimPending(now, leaseUntil, true)
      : await this.repository.claimPending(now, leaseUntil);
    const summary: OnboardingDispatchSummary = { claimed: leases.length, sent: 0, retried: 0, paused: 0, cleared: 0, leaseLost: 0 };

    for (const lease of leases) await this.deliverOne(lease, summary);
    return summary;
  }

  private async pause(lease: OnboardingEmailLease, reason: OnboardingEmailRepairReason, summary: OnboardingDispatchSummary) {
    if (await this.repository.pauseForRepair(lease, reason, this.clock())) summary.paused++;
    else summary.leaseLost++;
  }

  private async clearExpired(lease: OnboardingEmailLease, reason: OnboardingEmailTerminalReason, summary: OnboardingDispatchSummary) {
    if (await this.repository.clearExpiredOrConsumed(lease, reason, this.clock())) summary.cleared++;
    else summary.leaseLost++;
  }

  private async deliverOne(lease: OnboardingEmailLease, summary: OnboardingDispatchSummary): Promise<void> {
    if (lease.purpose !== 'checkout-invitation' && lease.purpose !== 'activation') {
      await this.pause(lease, 'unsupported_purpose', summary);
      return;
    }
    if (lease.purpose === 'activation' && !this.activationEnabled) {
      await this.pause(lease, 'unsupported_purpose', summary);
      return;
    }
    const now = this.clock();
    if (lease.consumedAt) {
      await this.clearExpired(lease, 'consumed', summary);
      return;
    }
    if (lease.expiresAt.getTime() <= now.getTime()) {
      await this.clearExpired(lease, 'expired', summary);
      return;
    }

    const recipient = typeof lease.email === 'string' ? lease.email.trim().toLowerCase() : '';
    if (!recipient || !emailValido(recipient)) {
      await this.pause(lease, 'missing_recipient', summary);
      return;
    }
    if (!this.config.allowedEmails.has(recipient)) {
      await this.pause(lease, 'not_allowlisted', summary);
      return;
    }
    if (!UUID.test(lease.invitationId) || !lease.encryptedToken) {
      await this.pause(lease, 'invalid_ciphertext', summary);
      return;
    }
    if (!await this.repository.leaseIsCurrent(lease, now)) {
      summary.leaseLost++;
      return;
    }

    let token: string;
    try {
      token = decryptOnboardingToken(lease.encryptedToken, this.config.tokenKey);
      if (hashOnboardingToken(token) !== lease.tokenHash) throw new Error('Token payload mismatch.');
    } catch {
      await this.pause(lease, 'invalid_ciphertext', summary);
      return;
    }

    const activation = lease.purpose === 'activation';
    const link = new URL(activation ? '/onboarding/ativacao' : '/onboarding/convite', this.baseUrl);
    link.hash = `token=${token}`;
    const rendered = activation
      ? renderActivationInvitation({ name: lease.name ?? '', url: link.toString() })
      : renderCheckoutInvitation({ name: lease.name ?? '', url: link.toString() });
    const messageId = `<onboarding-${lease.invitationId}@${this.baseUrl.hostname}>`;
    const message: EmailMessage & { messageId: string } = {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      messageId,
      from: this.from,
    };

    try {
      await this.mailer.sendMail(message);
    } catch {
      // SMTP may have accepted the message before a network error. Retries use the same Message-ID (at-least-once).
      const failedAt = this.clock();
      const retryAt = new Date(failedAt.getTime() + retryDelay(lease.attempts));
      if (await this.repository.scheduleRetry(lease, failedAt, retryAt)) summary.retried++;
      else summary.leaseLost++;
      return;
    }

    // A crash after SMTP acceptance and before this ack can cause a retry; delivery is at-least-once.
    if (await this.repository.markSent(lease, this.clock())) summary.sent++;
    else summary.leaseLost++;
  }
}
