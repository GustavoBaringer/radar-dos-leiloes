import { queryResultWithClient } from '../infra/database/query.js';
import { PrismaService } from '../infra/database/prisma.service.js';

export const pool = {
  async query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return queryResultWithClient(PrismaService.getInstance(), sql, params);
  },
  async end(): Promise<void> {
    await PrismaService.disconnectInstance();
  },
};

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}
