import type { PrismaClient } from '../generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { queryWithClient } from '../query.js';
import { withDatabaseTransaction } from '../transactions.js';

export type OnboardingAdmissionPolicy = { mode: 'legacy' } | { mode: 'staging'; issuer: string };

export class OnboardingAdmissionRepository {
  constructor(private readonly prisma: PrismaClient = PrismaService.getInstance()) {}

  async initializeBaseline(input: { issuer: string; userIds: readonly string[] }): Promise<'initialized' | 'already_initialized'> {
    const issuer = validateIssuer(input?.issuer);
    const userIds = normalizeUserIds(input?.userIds);
    return withDatabaseTransaction(this.prisma, async tx => {
      await queryWithClient(tx, `SELECT pg_advisory_xact_lock(738291, 1) IS NULL AS locked`);
      const [existing] = await queryWithClient<{ id: number }>(tx,
        'SELECT id FROM onboarding_staging_admission WHERE id=1 FOR UPDATE');
      if (existing) return 'already_initialized';

      const users = await queryWithClient<{ id: string }>(tx, `
        SELECT id::text AS id FROM users WHERE id = ANY($1::bigint[]) AND sub IS NOT NULL FOR SHARE
      `, [userIds]);
      if (users.length !== userIds.length) throw new Error('Baseline includes an unknown or unlinked user');

      await queryWithClient(tx, `
        INSERT INTO onboarding_staging_admission (id, issuer, baseline_initialized)
        VALUES (1, $1, TRUE)
      `, [issuer]);
      if (userIds.length) {
        await queryWithClient(tx, `
          INSERT INTO onboarding_staging_baseline_users (user_id, policy_id)
          SELECT ids.user_id, 1 FROM unnest($1::bigint[]) AS ids(user_id)
        `, [userIds]);
      }
      return 'initialized';
    });
  }

  async readPolicy(): Promise<OnboardingAdmissionPolicy> {
    const [table] = await queryWithClient<{ tableName: string | null }>(this.prisma,
      "SELECT to_regclass('public.onboarding_staging_admission')::text AS \"tableName\"");
    if (!table?.tableName) return { mode: 'legacy' };
    const [policy] = await queryWithClient<{ issuer: string }>(this.prisma,
      'SELECT issuer FROM onboarding_staging_admission WHERE id=1 AND baseline_initialized=TRUE');
    return policy ? { mode: 'staging', issuer: policy.issuer } : { mode: 'legacy' };
  }

  async assertInitialized(expectedIssuer: string): Promise<void> {
    const issuer = validateIssuer(expectedIssuer);
    const policy = await this.readPolicy();
    if (policy.mode !== 'staging' || policy.issuer !== issuer) {
      throw new Error('Staging admission baseline is not initialized for this issuer');
    }
  }

  async allowsUser(userId: string, expectedIssuer: string): Promise<boolean> {
    const issuer = validateIssuer(expectedIssuer);
    const id = normalizeUserId(userId);
    if (!id) return false;
    const policy = await this.readPolicy();
    if (policy.mode !== 'staging' || policy.issuer !== issuer) return false;
    const [row] = await queryWithClient<{ allowed: boolean }>(this.prisma, `
      SELECT EXISTS (
        SELECT 1 FROM onboarding_staging_baseline_users b
        WHERE b.user_id=$1::bigint AND b.policy_id=1
      ) OR EXISTS (
        SELECT 1 FROM users u
        JOIN onboarding_identity_bindings ib ON ib.user_id=u.id AND ib.subject=u.sub AND ib.issuer=$2
        JOIN onboarding_initial_payments ip ON ip.cadastro_id=ib.cadastro_id AND ip.state='paid_pending_activation'
        JOIN onboarding_paid_access_payments p ON p.initial_payment_id=ip.id
        WHERE u.id=$1::bigint AND u.sub IS NOT NULL AND p.starts_at <= now() AND now() < p.ends_at
      ) AS allowed
    `, [id, issuer]);
    return row?.allowed === true;
  }

  async allowsSubject(sub: string, expectedIssuer: string): Promise<boolean> {
    const issuer = validateIssuer(expectedIssuer);
    if (typeof sub !== 'string' || !sub.trim() || sub.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(sub)) return false;
    const policy = await this.readPolicy();
    if (policy.mode !== 'staging' || policy.issuer !== issuer) return false;
    const [row] = await queryWithClient<{ allowed: boolean }>(this.prisma, `
      SELECT EXISTS (
        SELECT 1 FROM users u
        JOIN onboarding_staging_baseline_users b ON b.user_id=u.id AND b.policy_id=1
        WHERE u.sub=$1
      ) OR EXISTS (
        SELECT 1 FROM users u
        JOIN onboarding_identity_bindings ib ON ib.user_id=u.id AND ib.subject=u.sub AND ib.issuer=$2
        JOIN onboarding_initial_payments ip ON ip.cadastro_id=ib.cadastro_id AND ip.state='paid_pending_activation'
        JOIN onboarding_paid_access_payments p ON p.initial_payment_id=ip.id
        WHERE u.sub=$1 AND p.starts_at <= now() AND now() < p.ends_at
      ) AS allowed
    `, [sub, issuer]);
    return row?.allowed === true;
  }
}

function normalizeUserId(value: string): string | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  try {
    const id = BigInt(value);
    return id <= BigInt('9223372036854775807') ? id.toString() : null;
  } catch { return null; }
}

function normalizeUserIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new TypeError('Baseline user IDs must be an explicit array');
  const ids = values.map(normalizeUserId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new TypeError('Invalid or duplicate baseline user ID');
  return ids as string[];
}

function validateIssuer(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new TypeError('Invalid staging admission issuer');
  }
  let url: URL;
  try { url = new URL(value.replace(/\/$/, '')); } catch { throw new TypeError('Invalid staging admission issuer'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid staging admission issuer');
  }
  return url.toString().replace(/\/$/, '');
}
