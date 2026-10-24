import type { Papel } from '../../../domain/identity/session.js';
import type { Prisma, PrismaClient } from '../generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

export type ActivationPrincipal = {
  sub: string;
  email: string;
  emailVerified: true;
  nome: string | null;
  papel: Papel;
};

export type ActivationIntent = {
  id: string;
  cadastroId: string;
  nonce: string;
  encryptedVerifier: Uint8Array;
  issuer: string;
  clientId: string;
  redirectUri: string;
  expiresAt: Date;
};

export type StartActivationMaterial = {
  invitationTokenHash: string;
  stateHash: string;
  browserTokenHash: string;
  nonce: string;
  encryptedVerifier: Uint8Array;
  issuer: string;
  clientId: string;
  redirectUri: string;
  expiresAt: Date;
};

type ActivationConfig = {
  allowedEmails: readonly string[];
  issuer: string;
  clientId: string;
  redirectUri: string;
};

class ActivationBindingConflict extends Error {}
class ActivationIntentConflict extends Error {}

const VALID_PAYMENT = `p.state='paid_pending_activation'
  AND p.payment_status IN ('CONFIRMED', 'RECEIVED')
  AND p.payment_value=69.90 AND p.payment_billing_type='CREDIT_CARD'
  AND p.subscription_status='ACTIVE' AND p.subscription_value=69.90 AND p.cycle='MONTHLY'
  AND p.payment_id<>'' AND p.subscription_id<>''
  AND p.checkout_id=a.checkout_id AND a.state='created' AND a.checkout_id IS NOT NULL`;

export class OnboardingActivationRepository {
  private readonly emails: string[];
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly redirectUri: string;

  constructor(config: ActivationConfig, private readonly prisma: PrismaClient = PrismaService.getInstance()) {
    this.issuer = normalizeIssuer(config?.issuer);
    this.clientId = typeof config?.clientId === 'string' ? config.clientId.trim() : '';
    this.redirectUri = normalizeRedirect(config?.redirectUri);
    if (!this.clientId || this.clientId.length > 256 || /[\x00-\x1f\x7f]/.test(this.clientId)) {
      throw new TypeError('Invalid activation OIDC client configuration');
    }
    this.emails = [...new Set((config.allowedEmails ?? []).map(email => email.trim().toLowerCase()).filter(Boolean))];
  }

  async startAtomic(input: StartActivationMaterial): Promise<{ status: 'started'; intentId: string } | { status: 'invalid' }> {
    if (!this.emails.length || !validStart(input) || !matchesConfig(input, this.issuer, this.clientId, this.redirectUri)) {
      return { status: 'invalid' };
    }
    try {
      return await withDatabaseTransaction(this.prisma, async tx => {
        const [invitation] = await queryWithClient<{ id: string; cadastroId: string }>(tx, `
          SELECT i.id, i.cadastro_id AS "cadastroId"
          FROM onboarding_invitations i
          JOIN cadastros c ON c.id=i.cadastro_id
          JOIN onboarding_registrations r ON r.cadastro_id=c.id
          JOIN onboarding_initial_payments p ON p.activation_invitation_id=i.id AND p.cadastro_id=c.id
          JOIN onboarding_checkout_attempts a ON a.id=p.checkout_attempt_id AND a.cadastro_id=c.id
          WHERE i.token_hash=$1 AND i.purpose='activation' AND i.consumed_at IS NULL AND i.expires_at>now()
            AND r.email_verified_at IS NOT NULL AND lower(trim(c.email))=ANY($2::text[])
            AND ${VALID_PAYMENT}
            AND NOT EXISTS (SELECT 1 FROM onboarding_identity_bindings b WHERE b.cadastro_id=c.id)
          FOR UPDATE OF i, c, r, p, a
        `, [input.invitationTokenHash, this.emails]);
        if (!invitation) return { status: 'invalid' };

        const [lifetime] = await queryWithClient<{ acceptable: boolean }>(tx, `
          SELECT $1::timestamptz BETWEEN now()+interval '9 minutes 58 seconds'
            AND now()+interval '10 minutes 2 seconds' AS acceptable
        `, [input.expiresAt]);
        if (!lifetime?.acceptable) return { status: 'invalid' };

        const [consumed] = await queryWithClient<{ id: string }>(tx, `
          UPDATE onboarding_invitations SET consumed_at=now()
          WHERE id=$1 AND purpose='activation' AND consumed_at IS NULL AND expires_at>now()
          RETURNING id
        `, [invitation.id]);
        if (!consumed) return { status: 'invalid' };

        const [intent] = await queryWithClient<{ id: string }>(tx, `
          INSERT INTO onboarding_activation_intents (
            invitation_id, cadastro_id, state_hash, browser_token_hash, nonce, encrypted_verifier,
            issuer, client_id, redirect_uri, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT DO NOTHING RETURNING id
        `, [invitation.id, invitation.cadastroId, input.stateHash, input.browserTokenHash, input.nonce,
          Buffer.from(input.encryptedVerifier), input.issuer, input.clientId, input.redirectUri, input.expiresAt]);
        if (!intent) throw new ActivationIntentConflict();
        return { status: 'started', intentId: intent.id };
      });
    } catch (error) {
      if (error instanceof ActivationIntentConflict) return { status: 'invalid' };
      throw error;
    }
  }

  async claimCallback(stateHash: string, browserTokenHash: string): Promise<ActivationIntent | null> {
    if (!this.emails.length || !validHash(stateHash) || !validHash(browserTokenHash)) return null;
    return withDatabaseTransaction(this.prisma, async tx => {
      await queryWithClient(tx, `
        UPDATE onboarding_activation_intents i
        SET state='failed', encrypted_verifier=NULL, consumed_at=COALESCE(consumed_at, now()), updated_at=now()
        FROM cadastros c
        WHERE c.id=i.cadastro_id AND i.state='pending' AND i.expires_at<=now()
          AND i.state_hash=$1 AND i.browser_token_hash=$2 AND lower(trim(c.email))=ANY($3::text[])
          AND i.issuer=$4 AND i.client_id=$5 AND i.redirect_uri=$6
      `, [stateHash, browserTokenHash, this.emails, this.issuer, this.clientId, this.redirectUri]);

      const rows = await queryWithClient<ActivationIntent>(tx, `
        UPDATE onboarding_activation_intents i
        SET state='exchanging', updated_at=now()
        FROM cadastros c
        JOIN onboarding_registrations r ON r.cadastro_id=c.id
        JOIN onboarding_initial_payments p ON p.cadastro_id=c.id
        JOIN onboarding_checkout_attempts a ON a.id=p.checkout_attempt_id AND a.cadastro_id=c.id
        WHERE i.cadastro_id=c.id AND i.state='pending' AND i.expires_at>now()
          AND i.state_hash=$1 AND i.browser_token_hash=$2 AND lower(trim(c.email))=ANY($3::text[])
          AND i.issuer=$4 AND i.client_id=$5 AND i.redirect_uri=$6
          AND i.invitation_id=p.activation_invitation_id AND r.email_verified_at IS NOT NULL
          AND ${VALID_PAYMENT}
        RETURNING i.id, i.cadastro_id AS "cadastroId", i.nonce,
          i.encrypted_verifier AS "encryptedVerifier", i.issuer, i.client_id AS "clientId",
          i.redirect_uri AS "redirectUri", i.expires_at AS "expiresAt"
      `, [stateHash, browserTokenHash, this.emails, this.issuer, this.clientId, this.redirectUri]);
      return rows[0] ?? null;
    });
  }

  async bindAtomic(
    intentId: string,
    browserTokenHash: string,
    principal: ActivationPrincipal,
  ): Promise<{ status: 'bound'; userId: string } | { status: 'invalid' | 'conflict' }> {
    if (!this.emails.length || !intentId || !validHash(browserTokenHash)) return { status: 'invalid' };
    try {
      return await withDatabaseTransaction(this.prisma, async tx => {
        const [intent] = await queryWithClient<{
          id: string; cadastroId: string; cadastroEmail: string; state: string; expiresAt: Date;
        }>(tx, `
          SELECT i.id, i.cadastro_id AS "cadastroId", c.email AS "cadastroEmail", i.state, i.expires_at AS "expiresAt"
          FROM onboarding_activation_intents i
          JOIN cadastros c ON c.id=i.cadastro_id
          JOIN onboarding_registrations r ON r.cadastro_id=c.id
          JOIN onboarding_initial_payments p ON p.cadastro_id=c.id AND p.activation_invitation_id=i.invitation_id
          JOIN onboarding_checkout_attempts a ON a.id=p.checkout_attempt_id AND a.cadastro_id=c.id
          WHERE i.id=$1 AND i.browser_token_hash=$2 AND lower(trim(c.email))=ANY($3::text[])
            AND i.issuer=$4 AND i.client_id=$5 AND i.redirect_uri=$6 AND r.email_verified_at IS NOT NULL
            AND ${VALID_PAYMENT}
            AND (i.state='bound' OR (i.state='exchanging' AND i.expires_at>now()))
          FOR UPDATE OF i, c, p
        `, [intentId, browserTokenHash, this.emails, this.issuer, this.clientId, this.redirectUri]);
        if (!intent) return { status: 'invalid' };

        if (!validPrincipal(principal) || normalizeEmail(principal.email) !== normalizeEmail(intent.cadastroEmail)) {
          await this.failLocked(tx, intent.id);
          return { status: 'invalid' };
        }

        if (intent.state === 'bound') {
          const [bound] = await queryWithClient<{ userId: string; issuer: string; subject: string }>(tx, `
            SELECT user_id::text AS "userId", issuer, subject FROM onboarding_identity_bindings WHERE intent_id=$1
          `, [intent.id]);
          return bound?.issuer === this.issuer && bound.subject === principal.sub
            ? { status: 'bound', userId: bound.userId } : { status: 'conflict' };
        }

        const [existingBinding] = await queryWithClient<{ cadastroId: string; userId: string; intentId: string }>(tx, `
          SELECT cadastro_id AS "cadastroId", user_id::text AS "userId", intent_id AS "intentId"
          FROM onboarding_identity_bindings
          WHERE cadastro_id=$1 OR (issuer=$2 AND subject=$3)
          FOR UPDATE
        `, [intent.cadastroId, this.issuer, principal.sub]);
        if (existingBinding) {
          await this.failLocked(tx, intent.id);
          return { status: 'conflict' };
        }

        let [user] = await queryWithClient<{ userId: string }>(tx, `
          SELECT id::text AS "userId" FROM users WHERE sub=$1 FOR UPDATE
        `, [principal.sub]);
        if (!user) {
          [user] = await queryWithClient<{ userId: string }>(tx, `
            INSERT INTO users (sub, email, nome, papel)
            VALUES ($1,$2,$3,'comum')
            ON CONFLICT DO NOTHING
            RETURNING id::text AS "userId"
          `, [principal.sub, intent.cadastroEmail, principal.nome?.trim() || null]);
          if (!user) {
            [user] = await queryWithClient<{ userId: string }>(tx, `
              SELECT id::text AS "userId" FROM users WHERE sub=$1 FOR UPDATE
            `, [principal.sub]);
          }
        }
        if (!user) {
          await this.failLocked(tx, intent.id);
          return { status: 'conflict' };
        }

        const [binding] = await queryWithClient<{ cadastroId: string }>(tx, `
          INSERT INTO onboarding_identity_bindings (cadastro_id, user_id, intent_id, issuer, subject)
          VALUES ($1,$2::bigint,$3,$4,$5)
          ON CONFLICT DO NOTHING RETURNING cadastro_id AS "cadastroId"
        `, [intent.cadastroId, user.userId, intent.id, this.issuer, principal.sub]);
        if (!binding) throw new ActivationBindingConflict();

        const [completed] = await queryWithClient<{ id: string }>(tx, `
          UPDATE onboarding_activation_intents
          SET state='bound', encrypted_verifier=NULL, consumed_at=now(), updated_at=now()
          WHERE id=$1 AND state='exchanging' AND browser_token_hash=$2
          RETURNING id
        `, [intent.id, browserTokenHash]);
        if (!completed) throw new Error('Activation intent lost its exchange state');
        return { status: 'bound', userId: user.userId };
      });
    } catch (error) {
      if (error instanceof ActivationBindingConflict) {
        await this.failAtomic(intentId, browserTokenHash);
        return { status: 'conflict' };
      }
      throw error;
    }
  }

  async failAtomic(intentId: string, browserTokenHash: string): Promise<void> {
    if (!this.emails.length || !intentId || !validHash(browserTokenHash)) return;
    await queryWithClient(this.prisma, `
      UPDATE onboarding_activation_intents i
      SET state='failed', encrypted_verifier=NULL, consumed_at=COALESCE(consumed_at, now()), updated_at=now()
      FROM cadastros c
      WHERE c.id=i.cadastro_id AND i.id=$1 AND i.browser_token_hash=$2
        AND i.state IN ('pending','exchanging') AND lower(trim(c.email))=ANY($3::text[])
        AND i.issuer=$4 AND i.client_id=$5 AND i.redirect_uri=$6
    `, [intentId, browserTokenHash, this.emails, this.issuer, this.clientId, this.redirectUri]);
  }

  private async failLocked(tx: Prisma.TransactionClient, intentId: string): Promise<void> {
    await queryWithClient(tx, `UPDATE onboarding_activation_intents
      SET state='failed', encrypted_verifier=NULL, consumed_at=COALESCE(consumed_at, now()), updated_at=now()
      WHERE id=$1 AND state IN ('pending','exchanging')`, [intentId]);
  }
}

function normalizeIssuer(value: string | undefined): string {
  if (typeof value !== 'string') throw new TypeError('Invalid activation OIDC issuer configuration');
  const issuer = value.replace(/\/$/, '');
  let url: URL;
  try { url = new URL(issuer); } catch { throw new TypeError('Invalid activation OIDC issuer configuration'); }
  if (url.username || url.password || url.search || url.hash || !allowedOrigin(url)) {
    throw new TypeError('Invalid activation OIDC issuer configuration');
  }
  return issuer;
}

function normalizeRedirect(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new TypeError('Invalid activation redirect URI configuration');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid activation redirect URI configuration'); }
  if (url.username || url.password || url.hash || !allowedOrigin(url)) {
    throw new TypeError('Invalid activation redirect URI configuration');
  }
  return url.toString();
}

function allowedOrigin(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

function validHash(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validStart(input: StartActivationMaterial): boolean {
  return !!input && validHash(input.invitationTokenHash) && validHash(input.stateHash) && validHash(input.browserTokenHash)
    && typeof input.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.nonce)
    && Buffer.from(input.nonce, 'base64url').length === 32
    && Buffer.from(input.nonce, 'base64url').toString('base64url') === input.nonce
    && input.encryptedVerifier instanceof Uint8Array && input.encryptedVerifier.byteLength === 72
    && input.encryptedVerifier[0] === 1 && input.expiresAt instanceof Date && Number.isFinite(input.expiresAt.getTime());
}

function matchesConfig(input: StartActivationMaterial, issuer: string, clientId: string, redirectUri: string): boolean {
  return input.issuer === issuer && input.clientId === clientId && input.redirectUri === redirectUri;
}

function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }

function validPrincipal(value: ActivationPrincipal): boolean {
  return !!value && value.emailVerified === true
    && typeof value.sub === 'string' && value.sub.trim().length > 0 && value.sub.length <= 512
    && !/[\x00-\x1f\x7f-\x9f]/.test(value.sub)
    && typeof value.email === 'string' && value.email.trim().length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())
    && (value.nome === null || (typeof value.nome === 'string' && value.nome.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value.nome)))
    && (value.papel === 'admin' || value.papel === 'comum');
}
