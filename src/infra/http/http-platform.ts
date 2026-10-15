import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COOKIE, lerToken, precisaRenovar, criarToken } from '../../infra/auth/session.js';
import { loadProxyTrustConfig } from '../../core/antibot/proxy.js';
import { loadAntibotConfig } from '../config/antibot-config.js';
import { loadChallengeConfig } from '../../core/antibot/challenge.js';
import { registerAntibot } from '../../core/antibot/fastify.js';
import { createChallengeHook } from '../../core/antibot/challenge.js';
import { normalizeClientIp } from '../../domain/security/client-ip.js';
import type { RadarHttpOptions } from './http-contracts.js';
import { RadarHttpContext, type RadarHttpRequest } from './radar-http-context.js';

export function createRadarHttpContext(options: RadarHttpOptions): RadarHttpContext { return new RadarHttpContext(options); }

const FREE = new Set(['/login', '/api/login', '/auth/login', '/auth/callback', '/auth/logout', '/sw.js', '/nopic.svg', '/nopic-imovel.svg', '/ca.crt', '/login-hero.jpg', '/api/security-config', '/challenge.js', '/challenge.css', '/landing-antibot.js', '/landing-antibot.html']);
const PUBLIC = new Set(['/', '/robots.txt', '/sitemap.xml', '/api/vitrine', '/api/espera', '/api/cadastro', '/api/security-config', '/api/img', '/landing.css', '/landing.js', '/challenge.js', '/challenge.css', '/landing-antibot.js', '/landing-antibot.html', '/cartao.js', '/cartao.css', '/slug.js', '/nopic.svg', '/nopic-imovel.svg', '/mapa-lotes.jpg']);
const crawler = /facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Slack-ImgProxy|TelegramBot|Googlebot|bingbot|Applebot/i;
const PAGE_404 = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Página não encontrada · Radar de Leilões</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;
 background:#05070f;color:#eef3ff;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
 h1{font-size:24px;margin:0 0 8px}p{color:#93a4c4;margin:0 0 22px}a{display:inline-block;margin:0 6px;padding:11px 18px;
 border-radius:10px;text-decoration:none;font-weight:600}.p{background:#2f6bff;color:#fff}.s{border:1px solid #1e2941;color:#eef3ff}</style>
 </head><body><main><h1>Esta página não existe</h1><p>O endereço pode ter mudado ou o lote saiu do ar.</p>
 <a class="p" href="/busca">Buscar lotes</a><a class="s" href="/">Ir para o início</a></main></body></html>`;
const htmlRequest = (req: FastifyRequest) => String(req.headers.accept ?? '').includes('text/html') && !req.url.startsWith('/api/');

@Catch()
export class RadarHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<import('fastify').FastifyReply>();
    const statusCode = exception instanceof HttpException
      ? exception.getStatus()
      : (exception as { statusCode?: number } | null)?.statusCode;
    const status = statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const message = exception instanceof HttpException ? exception.message : (exception as Error)?.message ?? 'erro';
    if (htmlRequest(req)) {
      reply.code(status).type('text/html; charset=utf-8').send(PAGE_404);
      return;
    }
    const validSources = (exception as { fontesValidas?: unknown } | null)?.fontesValidas;
    reply.code(status).send({ erro: status >= 500 ? 'erro interno' : message,
      ...(Array.isArray(validSources) ? { fontesValidas: validSources } : {}) });
  }
}

/** Configure shared transport/security on Nest's existing Fastify instance before app.init(). */
export async function configureHttpPlatform(app: NestFastifyApplication, context: RadarHttpContext): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  loadProxyTrustConfig(context.env);
  if (fastify.initialConfig.bodyLimit !== 16 * 1024) throw new Error('FastifyAdapter must be created with radarHttpAdapterOptions(env).');
  // Nest's FastifyAdapter registers @fastify/formbody's urlencoded parser in app.init().
  await fastify.register(fastifyStatic, { root: context.paths.webRoot, prefix: '/', index: false });
  app.useGlobalFilters(new RadarHttpExceptionFilter());
  fastify.addHook('onSend', async (req, reply, payload) => {
    const challengeOrigins = loadChallengeConfig(context.env).mode === 'enforce' ? ' https://challenges.cloudflare.com' : '';
    const csp = [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
      `script-src 'self' 'unsafe-inline'${challengeOrigins}`,
      ...(challengeOrigins ? ['frame-src https://challenges.cloudflare.com'] : []),
      `connect-src 'self' ws: wss:${challengeOrigins}`,
    ].join('; ');
    reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'SAMEORIGIN')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .header('content-security-policy', csp);
    if (req.url.startsWith('/api/') || req.url === '/ws') reply.header('cache-control', 'no-store');
    return payload;
  });

  const config = loadAntibotConfig(context.env);
  fastify.addHook('preHandler', createChallengeHook(context.challenge));
  const driver = context.runtime.createAntibotDriver?.(config);
  const antibotRedis = config.mode !== 'off' && !driver ? context.runtime.createAntibotRedis(config.redisUrl) : undefined;
  fastify.addHook('onClose', async () => {
    if (antibotRedis) {
      try { if (antibotRedis.status === 'ready') await antibotRedis.quit(); else antibotRedis.disconnect(); }
      catch { antibotRedis.disconnect(); }
    }
    await context.close();
  });
  const antibot = await registerAntibot(fastify, { config, driver, redisClient: antibotRedis as never,
    observer: context.telemetry.observeAntibot });
  context.setReadAdmission(() => antibot.acquireDegradedWork());
  fastify.addHook('onRequest', async (req, reply) => {
    const actorRequest = req as RadarHttpRequest;
    const path = req.url.split('?')[0]!;
    if (FREE.has(path)) return;
    const noSession = !/(?:^|;)\s*radar_sessao=/.test(String(req.headers.cookie ?? ''));
    if ((PUBLIC.has(path) || path.startsWith('/assets/')) && noSession && (req.method === 'GET' || path === '/api/espera' || path === '/api/cadastro')) {
      Object.assign(actorRequest, { eu: context.identity.ANONIMO, papel: 'comum' }); return;
    }
    if (path === '/api/security/metrics' && noSession && req.method === 'GET') {
      Object.assign(actorRequest, { eu: context.identity.ANONIMO, papel: 'comum' }); return;
    }
    const token = String(req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')).find(([key]) => key === COOKIE)?.[1];
    const session = lerToken(token);
    if (session.valido && session.papel) {
      const identity = session.sub ? await context.identity.identidadePorSub(session.sub) : await context.identity.usuarioDoPortao(session.papel);
      if (!identity) {
        if (path.startsWith('/api/') || path === '/ws') return reply.code(401).header('cache-control', 'no-store').send({ error: 'unauthorized' });
        return reply.code(302).header('location', '/login').send();
      }
      Object.assign(actorRequest, { eu: identity, papel: identity.papel });
      if (precisaRenovar(session)) {
        const secure = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '') === 'https';
        const refreshed = criarToken(session.papel, session.sub, session.nasceu);
        reply.header('set-cookie', `${COOKIE}=${refreshed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure ? '; Secure' : ''}`);
      }
      return;
    }
    if ((PUBLIC.has(path) || path.startsWith('/assets/')) && req.method === 'GET') {
      Object.assign(actorRequest, { eu: context.identity.ANONIMO, papel: 'comum' }); return;
    }
    if (path.startsWith('/lote/') && req.method === 'GET' && crawler.test(String(req.headers['user-agent'] ?? ''))) {
      Object.assign(actorRequest, { eu: context.identity.ANONIMO, papel: 'comum' }); return;
    }
    if (path.startsWith('/api/') || path === '/ws') return reply.code(401).header('cache-control', 'no-store').send({ erro: 'não autenticado' });
    return reply.code(302).header('location', `/login?de=${encodeURIComponent(req.url)}`).send();
  });
  fastify.addHook('onRequest', async req => { (req as RadarHttpRequest).clientIp = normalizeClientIp(String(req.ip ?? '')); });
  await context.initialize();
}

/** Fastify constructor-only settings consumed by the caller creating the Nest adapter. */
export function radarHttpAdapterOptions(env: NodeJS.ProcessEnv) {
  const proxy = loadProxyTrustConfig(env);
  return { bodyLimit: 16 * 1024, trustProxy: proxy.trustProxy ? [...proxy.trustProxy] : false };
}
