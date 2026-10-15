import { Injectable } from '@nestjs/common';
import type { Papel } from '../../infra/auth/session.js';
import { createResourcePool } from '../../application/security/resource-limits.js';
import { loadAntibotConfig } from '../config/antibot-config.js';
import { loadChallengeConfig, createChallengeService } from '../../core/antibot/challenge.js';
import { createOperationsTelemetry } from '../../application/security/antibot-telemetry.js';
import { createImageTelemetry } from '../../core/antibot/image-telemetry.js';
import { loadProxyTrustConfig } from '../../core/antibot/proxy.js';
import type { Identidade } from '../../domain/identity/identidade.js';
import type { FastifyRequest } from 'fastify';
import type { RadarHttpOptions } from './http-contracts.js';

export interface RadarActorContext {
  eu: Identidade;
  papel: Papel;
}
export interface RadarHttpRequest extends FastifyRequest {
  eu?: Identidade;
  papel?: Papel;
  clientIp?: string;
}

/** Per-application dependencies and resource ownership; no HTTP request/reply API. */
@Injectable()
export class RadarHttpContext {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: RadarHttpOptions['paths'];
  readonly dependencies: RadarHttpOptions['dependencies'];
  readonly data: RadarHttpOptions['dependencies']['data'];
  readonly identity: RadarHttpOptions['dependencies']['identity'];
  readonly oidc: RadarHttpOptions['dependencies']['oidc'];
  readonly jobs: RadarHttpOptions['dependencies']['jobs'];
  readonly runtime: RadarHttpOptions['dependencies']['runtime'];
  readonly telemetry: ReturnType<typeof createOperationsTelemetry>;
  readonly imageTelemetry = createImageTelemetry();
  readonly challenge: ReturnType<typeof createChallengeService>;
  private readonly resources = createResourcePool();
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private readAdmission?: () => import('../../application/security/resource-limits.js').ResourceLease | null;
  private readonly redisClients = new Map<string, Promise<ReturnType<RadarHttpOptions['dependencies']['runtime']['makeRedis']>>>();
  private collectQueueHandle?: Promise<ReturnType<RadarHttpOptions['dependencies']['jobs']['createCollectQueue']>>;

  constructor(options: RadarHttpOptions) {
    if (!options.dependencies.oidc.oidcLigado()) throw new Error('OIDC obrigatório para iniciar a plataforma HTTP.');
    this.env = options.env;
    this.paths = options.paths;
    this.dependencies = options.dependencies;
    this.data = options.dependencies.data;
    this.identity = options.dependencies.identity;
    this.oidc = options.dependencies.oidc;
    this.jobs = options.dependencies.jobs;
    this.runtime = options.dependencies.runtime;
    const antibot = loadAntibotConfig(this.env);
    const challenge = loadChallengeConfig(this.env);
    this.telemetry = createOperationsTelemetry({ antibotMode: antibot.mode, challengeMode: challenge.mode,
      proxyTrustConfigured: loadProxyTrustConfig(this.env).trustedProxyCidrs.length > 0 });
    const service = createChallengeService({ config: challenge });
    this.challenge = { clientConfig: service.clientConfig, verify: async (action, token) => {
      const start = performance.now();
      try {
        const result = await service.verify(action, token);
        this.telemetry.observeChallenge(action, result.ok ? 'success' : result.kind, performance.now() - start);
        return result;
      } catch (error) {
        this.telemetry.observeChallenge(action, 'error', performance.now() - start);
        throw error;
      }
    } };
  }

  ownerFor(actor?: RadarActorContext | null): number {
    const id = actor?.eu.userId;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) throw Object.assign(new Error('Autenticação necessária.'), { statusCode: 401 });
    return id as number;
  }
  roleFor(actor?: RadarActorContext | null): Papel { return actor?.papel ?? 'comum'; }
  requireAdmin(role: Papel): void {
    if (role !== 'admin') throw Object.assign(new Error('requer administrador'), { statusCode: 403 });
  }

  async runRead<T>(work: () => T | Promise<T>): Promise<T> {
    const lease = this.resources.tryAcquireResource();
    if (!lease) throw Object.assign(new Error('overloaded'), { statusCode: 503 });
    let degraded: import('../../application/security/resource-limits.js').ResourceLease | null = null;
    try {
      if (this.readAdmission) degraded = this.readAdmission();
      if (this.readAdmission && !degraded) throw Object.assign(new Error('overloaded'), { statusCode: 503 });
    } catch (error) { lease.release(); throw error; }
    try { return await work(); } finally { degraded?.release(); lease.release(); }
  }

  setReadAdmission(admit: () => import('../../application/security/resource-limits.js').ResourceLease | null): void { this.readAdmission = admit; }

  async redisResource(kind: 'login' | 'signup' | 'subscriber' | 'ws'): Promise<ReturnType<RadarHttpOptions['dependencies']['runtime']['makeRedis']>> {
    if (this.closing) throw new Error('HTTP resources are closed.');
    let pending = this.redisClients.get(kind);
    if (!pending) {
      pending = (async () => {
        const client = kind === 'ws'
        ? this.runtime.createWsRedis(loadAntibotConfig(this.env).redisUrl)
        : this.runtime.makeRedis();
        if (client.status === 'wait') await client.connect();
        return client;
      })();
      this.redisClients.set(kind, pending);
    }
    try { return await pending; }
    catch (error) { this.redisClients.delete(kind); throw error; }
  }

  collectQueue(): Promise<ReturnType<RadarHttpOptions['dependencies']['jobs']['createCollectQueue']>> {
    if (this.closing) return Promise.reject(new Error('HTTP resources are closed.'));
    return this.collectQueueHandle ??= (async () => {
      const connection = this.runtime.makeRedis();
      this.redisClients.set('collect', Promise.resolve(connection));
      if (connection.status === 'wait') await connection.connect();
      return this.jobs.createCollectQueue(connection);
    })();
  }

  initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      try {
        await this.runtime.initialize();
        await this.data.ensureSources();
      } catch (error) {
        try { await this.close(); } catch { /* preserve startup cause */ }
        throw error;
      }
    })();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const failures: unknown[] = [];
      try { await (await this.collectQueueHandle)?.close(); } catch (error) { failures.push(error); }
      for (const pending of this.redisClients.values()) {
        try {
          const client = await pending;
          if (client.status === 'ready') await client.quit(); else client.disconnect();
        } catch (error) { failures.push(error); }
      }
      try { await this.runtime.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Falha ao fechar recursos da plataforma HTTP.');
    })();
  }
}

export const radarActorFromRequest = (request: Pick<RadarHttpRequest, 'eu' | 'papel'>): RadarActorContext | undefined =>
  request.eu && request.papel ? { eu: request.eu, papel: request.papel } : undefined;
