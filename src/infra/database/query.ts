import { Prisma } from './generated/client.js';
import type { PrismaClient } from './generated/client.js';
import { PrismaService } from './prisma.service.js';

type QueryClient = PrismaClient | Prisma.TransactionClient;

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === 'bigint') {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`BIGINT result ${key} cannot be represented safely as a number`);
      }
      return [key, Number(value)];
    }
    if (value instanceof Prisma.Decimal) return [key, value.toNumber()];
    return [key, value];
  }));
}

function returnsRows(sql: string): boolean {
  const statement = sql.replace(/^\s*(?:--[^\n]*\n\s*)*/, '').trimStart();
  if (/^(SELECT|VALUES|SHOW|TABLE)\b/i.test(statement)) return true;
  if (/^(INSERT|UPDATE|DELETE|MERGE)\b/i.test(statement)) return /\bRETURNING\b/i.test(statement);
  // WITH statements can contain data-modifying CTEs. The existing write CTE
  // returns rows (UPDATE ... RETURNING); read CTEs end in SELECT and are queried.
  // A command-only WITH without a row-producing outer statement is not used here.
  return /^WITH\b/i.test(statement);
}

export async function queryWithClient<T = any>(client: QueryClient, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await queryResultWithClient<T>(client, sql, params)).rows;
}

export async function queryResultWithClient<T = any>(client: QueryClient, sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  if (!returnsRows(sql)) {
    const rowCount = await client.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  }
  const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
  return { rows: rows.map((row) => normalizeRow(row)) as T[], rowCount: rows.length };
}

export function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return queryWithClient(PrismaService.getInstance(), sql, params);
}
