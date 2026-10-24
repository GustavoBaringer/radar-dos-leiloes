import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

export type PendingOnboardingRegistration = {
  nome: string;
  cpfCnpj: string;
  tipoDocumento: 'CPF' | 'CNPJ';
  email: string;
  celular: string;
  consentimentoTermosEm: Date;
  consentimentoVersao: string;
  consentimentoTexto: string;
  consentimentoIp: string | null;
  consentimentoMarketing: boolean;
  origem: string | null;
};

export type CreatePendingInvitation = {
  cadastro: PendingOnboardingRegistration;
  tokenHash: string;
  encryptedToken: Uint8Array;
  expiresAt: Date;
};

export type CreatePendingInvitationResult =
  | { status: 'inserted'; cadastroId: string }
  | { status: 'duplicate' };

export type ConsumeInvitationResult = 'consumed' | 'invalid' | 'expired' | 'already-consumed';

export class OnboardingRepository {
  constructor(private readonly prisma: PrismaService = PrismaService.getInstance()) {}

  createPendingInvitationAtomic(input: CreatePendingInvitation): Promise<CreatePendingInvitationResult> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const [cadastro] = await queryWithClient<{ id: string }>(tx, `
        INSERT INTO cadastros
          (nome, cpf_cnpj, tipo_documento, email, celular, consentimento_termos_em,
           consentimento_versao, consentimento_texto, consentimento_ip, consentimento_marketing, origem)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        input.cadastro.nome, input.cadastro.cpfCnpj, input.cadastro.tipoDocumento,
        input.cadastro.email, input.cadastro.celular, input.cadastro.consentimentoTermosEm,
        input.cadastro.consentimentoVersao, input.cadastro.consentimentoTexto,
        input.cadastro.consentimentoIp, input.cadastro.consentimentoMarketing, input.cadastro.origem,
      ]);

      if (!cadastro) return { status: 'duplicate' };

      await queryWithClient(tx, 'INSERT INTO onboarding_registrations (cadastro_id) VALUES ($1)', [cadastro.id]);
      const [invitation] = await queryWithClient<{ id: string }>(tx, `
        INSERT INTO onboarding_invitations (cadastro_id, purpose, token_hash, expires_at)
        VALUES ($1, 'checkout-invitation', $2, $3)
        RETURNING id
      `, [cadastro.id, input.tokenHash, input.expiresAt]);
      if (!invitation) throw new Error('Could not create onboarding invitation');

      await queryWithClient(tx, `
        INSERT INTO onboarding_email_outbox (invitation_id, encrypted_token)
        VALUES ($1, $2)
      `, [invitation.id, Buffer.from(input.encryptedToken)]);
      return { status: 'inserted', cadastroId: cadastro.id };
    });
  }

  consumeInvitationAtomic(tokenHash: string, now: Date): Promise<ConsumeInvitationResult> {
    return withDatabaseTransaction(this.prisma, async tx => {
      const [invitation] = await queryWithClient<{
        id: string; cadastro_id: string; purpose: string; expires_at: Date; consumed_at: Date | null;
      }>(tx, `
        SELECT id, cadastro_id, purpose, expires_at, consumed_at
        FROM onboarding_invitations
        WHERE token_hash = $1
        FOR UPDATE
      `, [tokenHash]);

      if (!invitation || invitation.purpose !== 'checkout-invitation') return 'invalid';
      if (invitation.consumed_at) return 'already-consumed';
      if (new Date(invitation.expires_at).getTime() <= now.getTime()) return 'expired';

      const [registration] = await queryWithClient<{ cadastro_id: string }>(tx, `
        SELECT cadastro_id FROM onboarding_registrations
        WHERE cadastro_id = $1
        FOR UPDATE
      `, [invitation.cadastro_id]);
      if (!registration) return 'invalid';

      const [activeAttempt] = await queryWithClient<{ id: string }>(tx, `
        SELECT id FROM onboarding_checkout_attempts
        WHERE cadastro_id = $1
          AND state IN ('requested', 'dispatching', 'created', 'unknown')
        LIMIT 1
      `, [invitation.cadastro_id]);
      if (activeAttempt) return 'invalid';

      const [consumed] = await queryWithClient<{ id: string }>(tx, `
        UPDATE onboarding_invitations
        SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING id
      `, [invitation.id, now]);
      if (!consumed) return 'expired';

      const [verified] = await queryWithClient<{ cadastro_id: string }>(tx, `
        UPDATE onboarding_registrations
        SET email_verified_at = COALESCE(email_verified_at, $2)
        WHERE cadastro_id = $1
        RETURNING cadastro_id
      `, [invitation.cadastro_id, now]);
      if (!verified) throw new Error('Could not verify onboarding registration');

      await queryWithClient(tx, `
        INSERT INTO onboarding_checkout_attempts (cadastro_id, invitation_id)
        VALUES ($1, $2)
      `, [invitation.cadastro_id, invitation.id]);
      return 'consumed';
    });
  }
}
