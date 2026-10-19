import { Prisma, PrismaClient } from './generated/client.js';

// Keep a bounded transaction lifetime explicit; callers must not depend on the
// database driver's much longer implicit timeout.
export function withDatabaseTransaction<T>(
  client: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(work, { maxWait: 5_000, timeout: 15_000 });
}
