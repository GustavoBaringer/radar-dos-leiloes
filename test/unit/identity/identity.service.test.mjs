import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IdentityService } from '../../../dist/src/application/services/identity/identity.service.js';
import { IdentityRepository } from '../../../dist/src/infra/database/repositories/identity.repository.js';
import { ANONIMO } from '../../../dist/src/domain/identity/identidade.js';
import { defaultIdentityService } from '../../../dist/src/bootstrap/identity-composition.js';
import * as compatibility from '../../../dist/src/core/identidade.js';
import { HttpPlatformModule } from '../../../dist/src/application/modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../dist/src/infra/http/radar-http-context.js';
import { AuthModule } from '../../../dist/src/application/modules/auth/auth.module.js';
import { AuthService } from '../../../dist/src/application/services/auth/auth.service.js';
import { authDependencies } from '../../e2e/auth/helpers/auth-fixture.mjs';

describe('IdentityService cache and native provider ownership', () => {
  it('keys roles and positive identities only by subject, even when the repository returns equal emails', async () => {
    const rows = {
      'sub-a': { id: '1', email: 'shared@example.test', nome: 'A', papel: 'admin' },
      'sub-b': { id: '2', email: 'shared@example.test', nome: 'B', papel: 'comum' },
    };
    const select = jest.fn(async sub => rows[sub]);
    const service = new IdentityService({ identidadePorSub: select });
    const a = await service.identidadePorSub('sub-a');
    const b = await service.identidadePorSub('sub-b');
    expect(a).toMatchObject({ userId: 1, sub: 'sub-a', papel: 'admin' });
    expect(b).toMatchObject({ userId: 2, sub: 'sub-b', papel: 'comum' });
    expect(a.email).toBe(b.email);
    expect(await service.identidadePorSub('sub-a')).toBe(a);
    expect(await service.identidadePorSub('sub-b')).toBe(b);
    expect(select.mock.calls).toEqual([['sub-a'], ['sub-b']]);
  });

  it('caches positive sub lookups for exactly 30 seconds, never caches misses, and does not invalidate on upsert', async () => {
    let now = 1000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let row = { id: '41', email: 'same@example.test', nome: 'Name', papel: 'admin' };
    const repository = {
      identidadePorSub: jest.fn(async () => row),
      garantirUsuario: jest.fn(async dados => ({ ...row, ...dados, id: '41' })),
    };
    const service = new IdentityService(repository);
    try {
      const first = await service.identidadePorSub('subject');
      expect(first).toEqual({ userId: 41, sub: 'subject', email: row.email, nome: row.nome, papel: 'admin' });
      row = { ...row, papel: 'comum' };
      expect(await service.garantirUsuario({ sub: 'subject', papel: 'comum' })).toMatchObject({ userId: 41, papel: 'comum' });
      now = 30_999;
      expect(await service.identidadePorSub('subject')).toBe(first);
      expect(repository.identidadePorSub).toHaveBeenCalledTimes(1);
      now = 31_000;
      const refreshed = await service.identidadePorSub('subject');
      expect(refreshed).not.toBe(first);
      expect(refreshed.papel).toBe('comum');
      row = undefined;
      expect(await service.identidadePorSub('absent')).toBeNull();
      expect(await service.identidadePorSub('absent')).toBeNull();
      expect(repository.identidadePorSub.mock.calls.map(([sub]) => sub)).toEqual(['subject', 'subject', 'absent', 'absent']);
      // Existing deletion/revocation lag remains until TTL; expired misses are not recached.
      expect(await service.identidadePorSub('subject')).toBe(refreshed);
      now = 61_000;
      expect(await service.identidadePorSub('subject')).toBeNull();
      expect(await service.identidadePorSub('subject')).toBeNull();
      expect(repository.identidadePorSub).toHaveBeenCalledTimes(6);
    } finally { clock.mockRestore(); }
  });

  it('keeps the gate cache separate by role without TTL and retries missing gate rows', async () => {
    const repository = { usuarioDoPortao: jest.fn(async papel => papel === 'admin' ? { id: '7', nome: 'Gate' } : undefined) };
    const service = new IdentityService(repository);
    const admin = await service.usuarioDoPortao('admin');
    expect(admin).toEqual({ userId: 7, sub: null, email: null, nome: 'Gate', papel: 'admin' });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      expect(await service.usuarioDoPortao('admin')).toBe(admin);
      await expect(service.usuarioDoPortao('comum')).rejects.toThrow('conta do portão para o papel "comum" não existe — rode db/011_usuarios.sql');
      await expect(service.usuarioDoPortao('comum')).rejects.toThrow('conta do portão');
      repository.usuarioDoPortao.mockImplementation(async () => ({ id: '8', nome: null }));
      const common = await service.usuarioDoPortao('comum');
      expect(common.userId).toBe(8);
      expect(await service.usuarioDoPortao('comum')).toBe(common);
      expect(await service.usuarioDoPortao('admin')).toBe(admin);
      expect(repository.usuarioDoPortao.mock.calls.map(([role]) => role)).toEqual(['admin', 'comum', 'comum', 'comum']);
    } finally { clock.mockRestore(); }
  });

  it('shares one default class/cache with bound compatibility exports and the native composition, with a single ANONIMO reference', async () => {
    const sub = `identity-unit-${process.pid}`;
    const select = jest.spyOn(IdentityRepository.prototype, 'identidadePorSub').mockResolvedValue({ id: '42', email: null, nome: null, papel: 'comum' });
    const upsert = jest.spyOn(IdentityRepository.prototype, 'garantirUsuario').mockImplementation(async dados => ({ id: '42', email: null, nome: null, ...dados }));
    const gate = jest.spyOn(IdentityRepository.prototype, 'usuarioDoPortao').mockResolvedValue({ id: '7', nome: null });
    try {
      expect(defaultIdentityService).toBeInstanceOf(IdentityService);
      expect(compatibility.ANONIMO).toBe(ANONIMO);
      expect(defaultIdentityService.ANONIMO).toBe(ANONIMO);
      const { identidadePorSub, garantirUsuario, usuarioDoPortao } = compatibility;
      const first = await identidadePorSub(sub);
      expect(await defaultIdentityService.identidadePorSub(sub)).toBe(first);
      expect(select).toHaveBeenCalledTimes(1);
      expect(await garantirUsuario({ sub, papel: 'admin' })).toMatchObject({ userId: 42, papel: 'admin' });
      expect(await defaultIdentityService.identidadePorSub(sub)).toBe(first);
      expect(await usuarioDoPortao('admin')).toBe(await defaultIdentityService.usuarioDoPortao('admin'));
      expect(gate).toHaveBeenCalledTimes(1);
      const { createNativeHttpDependencies } = await import('../../../dist/src/bootstrap/native-http-dependencies.js');
      const dependencies = await createNativeHttpDependencies({ oidcLigado: () => true });
      expect(dependencies.identity).toBe(defaultIdentityService);
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally { select.mockRestore(); upsert.mockRestore(); gate.mockRestore(); }
  }, 60_000);

  it('returns the exact injected fake port and isolates two concurrent native AuthService applications without SQL', async () => {
    const apps = [];
    try {
      const fixtures = await Promise.all([1, 2].map(async owner => {
        const fixture = authDependencies();
        fixture.deps.identity.garantirUsuario = jest.fn(async identity => ({ ...identity, userId: owner }));
        class Root {}
        Module({ imports: [HttpPlatformModule.forRoot({
          dependencies: fixture.deps, env: { NODE_ENV: 'test', ANTIBOT_MODE: 'off' },
          paths: { projectRoot: process.cwd(), webRoot: '', appDist: '', certDir: '', dataDir: '' },
        }), AuthModule] })(Root);
        const app = await NestFactory.createApplicationContext(Root, { logger: false });
        apps.push(app);
        expect(Object.is(app.get(IdentityService), fixture.deps.identity)).toBe(true);
        expect(app.get(RadarHttpContext).identity).toBe(fixture.deps.identity);
        return { app, fixture };
      }));
      expect(fixtures[0].app.get(IdentityService)).not.toBe(fixtures[1].app.get(IdentityService));
      const results = await Promise.all(fixtures.map(({ app }) => app.get(AuthService).passwordLogin({
        body: { usuario: 'valid-user', senha: 'valid-password' }, ip: '127.0.0.1',
        origin: { protocol: 'http', host: 'localhost', secure: false },
      })));
      expect(results.map(result => result.status)).toEqual([302, 302]);
      for (const { fixture } of fixtures) expect(fixture.deps.identity.garantirUsuario).toHaveBeenCalledTimes(1);
    } finally { await Promise.all(apps.map(app => app.close())); }
  });
});
