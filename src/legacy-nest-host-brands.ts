import { Catch, type ArgumentsHost, type ExceptionFilter, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createLegacyHost, type LegacyHostOptions } from './legacy-host.js';
import { BrandsModule } from './modules/catalogo/adapters/http/brands.module.js';

/**
 * Pré-condição: `createLegacyHost` já instalou error/404 reais na raiz do
 * Fastify. Fastify recusa o segundo `setErrorHandler` e o init do Nest tenta
 * regravar os dois — este adapter é o dono dos setters globais e devolve a
 * instância intacta, sem chamar o super nem remendar a instância em runtime.
 */
export class LegacyOwnedFastifyAdapter extends FastifyAdapter {
  override setErrorHandler(
    _handler: Parameters<FastifyAdapter['setErrorHandler']>[0],
  ): ReturnType<FastifyAdapter['setErrorHandler']> {
    return this.instance;
  }

  override setNotFoundHandler(
    _handler: Parameters<FastifyAdapter['setNotFoundHandler']>[0],
  ): ReturnType<FastifyAdapter['setNotFoundHandler']> {
    return this.instance;
  }
}

/**
 * Exceção lançada dentro do controller Nest é respondida pelo handler legado:
 * só ele separa 4xx (mantém a mensagem) de 5xx (vira genérico) e decide HTML
 * por Accept. Sem isto o piloto responderia o envelope do Nest.
 */
@Catch()
export class LegacyHttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly legacyErrorHandler: FastifyInstance['errorHandler']) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.getArgByIndex(0);
    const reply = host.getArgByIndex(1);
    if (reply?.sent) return;
    const error = exception instanceof Error ? exception : new Error(String(exception));
    const status =
      typeof (exception as { getStatus?: unknown } | null)?.getStatus === 'function'
        ? (exception as { getStatus: () => number }).getStatus()
        : undefined;
    // HttpException vira { statusCode, message }; as demais seguem intactas.
    if (typeof status === 'number' && !('statusCode' in error)) {
      (error as { statusCode?: number }).statusCode = status;
    }
    this.legacyErrorHandler(error, request, reply);
  }
}

export interface LegacyNestBrandsPilot {
  /** Host legado com `excludeLegacyBrands`: dono de 404, erro, cabeçalhos e hooks. */
  host: Awaited<ReturnType<typeof createLegacyHost>>;
  /** Dono externo do fechamento: `nest.close()` fecha o Fastify uma única vez. */
  nest: INestApplication;
  /** Quem responde `GET /api/brands`: o Nest, o legado, ou ninguém. */
  brandsRoute: 'nest' | 'legacy' | 'none';
}

/**
 * Fábrica do piloto de marcas no Nest: um único Fastify, um único listener de
 * rota, parsers do host preservados (`bodyParser: false`) e rota legada
 * excluída nesta montagem. Fica fora do `server.ts`: o endpoint do stage2 não
 * muda — quem migrar o loader é quem vai chamar isto.
 */
export async function createLegacyNestHostBrands(
  options: LegacyHostOptions,
): Promise<LegacyNestBrandsPilot> {
  const host = await createLegacyHost({ ...options, excludeLegacyBrands: true });
  // Capturado antes do Nest: é o filtro global quem precisa deste handler.
  const legacyErrorHandler = host.app.errorHandler;
  const adapter = new LegacyOwnedFastifyAdapter(host.app);
  let nest: INestApplication | undefined;
  try {
    nest = await NestFactory.create(
      BrandsModule.forQuery(options.dependencies.data.query),
      adapter,
      { bodyParser: false, logger: false, abortOnError: false },
    );
    nest.useGlobalFilters(new LegacyHttpExceptionFilter(legacyErrorHandler));
    // Init antes de qualquer ready/inject: o Fastify congela rotas no ready.
    await nest.init();
    if (host.app.errorHandler !== legacyErrorHandler) {
      throw new Error('O init do Nest substituiu o error handler do host legado.');
    }
    const brandsRoute = host.legacyBrandsRegistered
      ? 'legacy'
      : host.app.hasRoute({ method: 'GET', url: '/api/brands' }) ? 'nest' : 'none';
    return { host, nest, brandsRoute };
  } catch (error) {
    try {
      if (nest) await nest.close();
      else await host.app.close();
    } catch {
      // Falha de montagem: o erro original é o que interessa.
    }
    throw error;
  }
}

/** Nome curto já usado pelos artefatos anteriores do piloto. */
export const createNestPilot = createLegacyNestHostBrands;
