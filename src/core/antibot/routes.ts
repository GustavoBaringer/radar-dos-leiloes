import type { PolicyId } from './types.js';
import { createChallengeHook, type createChallengeService } from './challenge.js';

export const ROUTE_POLICIES: Readonly<Record<string, PolicyId>> = {
  'GET /api/security-config': 'vitrine',
  'HEAD /api/security-config': 'vitrine',
  'GET /challenge.js': 'vitrine',
  'HEAD /challenge.js': 'vitrine',
  'GET /challenge.css': 'vitrine',
  'HEAD /challenge.css': 'vitrine',
  'GET /landing-antibot.js': 'vitrine',
  'HEAD /landing-antibot.js': 'vitrine',
  'GET /landing-antibot.html': 'vitrine',
  'HEAD /landing-antibot.html': 'vitrine',
  'GET /api/security/metrics': 'search',
  'HEAD /api/security/metrics': 'search',
  'GET /api/search': 'search',
  'HEAD /api/search': 'search',
  'GET /lote/:slug': 'detail',
  'HEAD /lote/:slug': 'detail',
  'GET /api/lot/:id': 'detail',
  'HEAD /api/lot/:id': 'detail',
  'GET /api/search/mapa': 'mapa',
  'HEAD /api/search/mapa': 'mapa',
  'GET /api/vitrine': 'vitrine',
  'HEAD /api/vitrine': 'vitrine',
  'GET /api/img': 'image',
  'HEAD /api/img': 'image',
  'POST /api/cadastro': 'cadastro',
  'POST /api/espera': 'espera',
  'POST /api/login': 'login',
  'GET /auth/login': 'login',
  'HEAD /auth/login': 'login',
  'GET /auth/callback': 'login',
  'HEAD /auth/callback': 'login',
  'GET /api/home': 'search',
  'HEAD /api/home': 'search',
  'GET /api/home/leiloeiro': 'search',
  'HEAD /api/home/leiloeiro': 'search',
  'GET /api/alerts': 'search',
  'HEAD /api/alerts': 'search',
  'GET /api/alerts/hits': 'search',
  'HEAD /api/alerts/hits': 'search',
  'GET /api/favorites': 'search',
  'HEAD /api/favorites': 'search',
  'GET /api/push/key': 'search',
  'HEAD /api/push/key': 'search',
  'GET /api/brands': 'search',
  'HEAD /api/brands': 'search',
  'GET /api/explain': 'search',
  'HEAD /api/explain': 'search',
  'GET /api/malha/:tipo': 'search',
  'HEAD /api/malha/:tipo': 'search',
  'GET /api/me': 'search',
  'HEAD /api/me': 'search',
  'POST /api/alerts': 'write',
  'PATCH /api/alerts/:id': 'write',
  'DELETE /api/alerts/:id': 'write',
  'POST /api/alerts/hits/seen': 'write',
  'POST /api/favorites': 'write',
  'DELETE /api/favorites/:lotId': 'write',
  'POST /api/push/subscribe': 'write',
  'GET /ws': 'wsIp',
};

/** Register the same route guard/assets adapter in the live server and inject fixtures. */
export function registerChallengeHttp(
  app: any,
  service: Pick<ReturnType<typeof createChallengeService>, 'verify' | 'clientConfig'>,
  sendAsset: (reply: any, file: string) => unknown,
): void {
  app.addHook('preHandler', createChallengeHook(service));
  app.get('/api/security-config', async (_request: any, reply: any) =>
    reply.header('Cache-Control', 'no-store').send(service.clientConfig()),
  );
  for (const [path, file] of [
    ['/challenge.js', 'challenge.js'],
    ['/challenge.css', 'challenge.css'],
    ['/landing-antibot.js', 'landing-antibot.js'],
    ['/landing-antibot.html', 'landing-antibot.html'],
  ]) {
    app.get(path, async (_request: any, reply: any) => sendAsset(reply, file));
  }
}

export function registerOperationsMetricsRoute(app: any, telemetry: { snapshot(): unknown }): void {
  app.get('/api/security/metrics', async (request: any, reply: any) => {
    const userId = request.eu?.userId;
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return reply.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized' });
    }
    if (request.papel !== 'admin') {
      return reply.code(403).header('Cache-Control', 'no-store').send({ error: 'forbidden' });
    }
    return reply.header('Cache-Control', 'no-store').send(telemetry.snapshot());
  });
}
