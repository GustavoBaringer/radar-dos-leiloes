import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../../../dist/src/infra/database/prisma.service.js';
import { IdentityRepository } from '../../../dist/src/infra/database/repositories/identity.repository.js';
import { IdentityService } from '../../../dist/src/application/services/identity/identity.service.js';

describe('IdentityService with real isolated PostgreSQL', () => {
  const prefix = `identity5-${process.pid}-${Date.now()}`;
  const subjects = [`${prefix}-a`, `${prefix}-b`];
  let prisma, repository, service;
  let ownsSubjects = false;
  const createdIds = [];

  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
    if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '55433' || db.pathname !== '/radar_prisma' ||
        db.username !== 'radar_test' || db.password !== 'radar_test_local' || db.search || db.hash) {
      throw Error('Refusing identity integration outside exact isolated radar_prisma fixture');
    }
    prisma = PrismaService.getInstance();
    await prisma.$connect();
    expect(await prisma.users.count({ where: { sub: { in: subjects } } })).toBe(0);
    ownsSubjects = true;
    repository = new IdentityRepository();
    service = new IdentityService(repository);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        if (ownsSubjects) await prisma.users.deleteMany({ where: { sub: { in: subjects } } });
        await prisma.users.deleteMany({ where: { id: { in: createdIds } } });
        if (ownsSubjects) expect(await prisma.users.count({ where: { sub: { in: subjects } } })).toBe(0);
        expect(await prisma.users.count({ where: { id: { in: createdIds } } })).toBe(0);
      }
    } finally { await PrismaService.disconnectInstance(); }
  });

  it('never inherits another subject through email; the existing unique email index rejects duplicates', async () => {
    const a = await service.garantirUsuario({ sub: subjects[0], email: `${prefix}@example.test`, nome: 'A', papel: 'admin' });
    // Existing db/011_usuarios.sql + Prisma baseline prohibit two non-null equal emails.
    // Preserve that constraint: duplicate email must fail, never upsert/return owner A by email.
    await expect(service.garantirUsuario({ sub: subjects[1], email: a.email, nome: 'B', papel: 'comum' }))
      .rejects.toThrow('users_email_uk');
    expect(await service.identidadePorSub(subjects[1])).toBeNull();
    expect(await prisma.users.count({ where: { sub: subjects[1] } })).toBe(0);
    const b = await service.garantirUsuario({ sub: subjects[1], email: null, nome: 'B', papel: 'comum' });
    expect(a.userId).not.toBe(b.userId);
    expect(b.email).toBeNull();
    expect(await service.identidadePorSub(subjects[0])).toEqual(a);
    expect(await service.identidadePorSub(subjects[1])).toEqual(b);
  });

  it('upserts the same subject, overwrites provider role and preserves blank/null email/name without invalidating its positive cache', async () => {
    const original = await service.identidadePorSub(subjects[0]);
    expect(original.papel).toBe('admin');
    const updated = await service.garantirUsuario({ sub: subjects[0], email: '', nome: null, papel: 'comum' });
    expect(updated).toEqual({ ...original, papel: 'comum' });
    expect(await service.identidadePorSub(subjects[0])).toBe(original);
    const persisted = await prisma.users.findUnique({ where: { id: BigInt(original.userId) } });
    expect(persisted).toMatchObject({ sub: subjects[0], email: original.email, nome: 'A', papel: 'comum' });
    expect(persisted.visto_em).toBeInstanceOf(Date);
    expect(await prisma.users.count({ where: { sub: subjects[0] } })).toBe(1);
    expect(await new IdentityService(repository).identidadePorSub(subjects[0])).toEqual(updated);
  });

  it('executes the ordered null-sub gate lookup without changing existing gate accounts', async () => {
    // Only own fixture row is created; the repository may correctly choose an earlier existing row.
    const own = await prisma.users.create({ data: { nome: prefix, papel: 'admin', sub: null } });
    createdIds.push(own.id);
    const first = await prisma.users.findFirst({ where: { papel: 'admin', sub: null }, orderBy: { id: 'asc' } });
    expect(await new IdentityService(repository).usuarioDoPortao('admin')).toEqual({
      userId: Number(first.id), sub: null, email: null, nome: first.nome, papel: 'admin',
    });
    expect(await repository.identidadePorSub(`${prefix}-absent`)).toBeUndefined();
  });
});
