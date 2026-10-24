import type { ChallengeAction } from '../../application/security/challenge.js';
import type { createChallengeService } from '../../application/security/challenge.js';

const ACTION_BY_ROUTE: Readonly<Record<string, ChallengeAction>> = {
  'POST /api/login': 'login',
  'POST /api/cadastro': 'cadastro',
  'POST /api/espera': 'espera',
};

export function createChallengeHook(service: Pick<ReturnType<typeof createChallengeService>, 'verify'>) {
  return async (request: any, reply: any): Promise<void> => {
    if (request.method !== 'POST') return;
    if (request.url?.split('?')[0] === '/api/webhooks/asaas') return;
    const action = ACTION_BY_ROUTE[`${request.method} ${request.routeOptions?.url ?? request.routerPath ?? ''}`];
    if (!action) return;
    const body = request.body;
    const token = body && typeof body === 'object' && !Array.isArray(body) ? body.turnstileToken : undefined;
    const result = await service.verify(action, token);
    if (result.ok) return;
    reply.code(result.kind === 'invalid' ? 403 : 503).header('Cache-Control', 'no-store');
    if (result.kind === 'invalid') reply.send({ error: 'challenge_failed' });
    else reply.header('Retry-After', '3').send({ error: 'challenge_unavailable', retryAfterSeconds: 3 });
  };
}
