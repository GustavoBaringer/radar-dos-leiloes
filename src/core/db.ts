import pg from 'pg';
import { queryResultWithClient } from '../infra/database/query.js';
import { PrismaService } from '../infra/database/prisma.service.js';

let legacyAdminPool: pg.Pool | undefined;

/** Explicit, temporary pg gateway for maintenance scripts that require connect()/BEGIN. */
function getLegacyAdminPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for legacy admin database access');
  return (legacyAdminPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
}

export const pool = {
  async query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return queryResultWithClient(PrismaService.getInstance(), sql, params);
  },
  // Administrative script-only compatibility; runtime query/upsert uses Prisma.
  connect: () => getLegacyAdminPool().connect(),
  async end(): Promise<void> {
    await Promise.all([
      PrismaService.disconnectInstance(),
      legacyAdminPool?.end(),
    ]);
    legacyAdminPool = undefined;
  },
};

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}
