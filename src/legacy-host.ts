import Fastify from 'fastify';
import { Agent } from 'undici';
import fastifyStatic from '@fastify/static';
import { pathToFileURL } from 'node:url';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { idDoSlug, slugDoLote } from './core/slug.js';
import { VENCIDO } from './core/encerramento.js';
import { criarToken, lerToken, precisaRenovar, JANELAS, COOKIE, type Papel } from './core/auth.js';
import { documento, celularValido, emailValido } from './core/cadastro.js';
import { BRAND_LIST, parseQuery } from './core/normalize.js';
import { registerBrandsRoute } from './modules/catalogo/adapters/http/brands.legacy.js';
import { loadAntibotConfig } from './core/antibot/config.js';
import { loadChallengeConfig, createChallengeService } from './core/antibot/challenge.js';
import { createDefaultObserver } from './core/antibot/engine.js';
import { loadProxyTrustConfig } from './core/antibot/proxy.js';
import { composeOperationsObserver, createOperationsTelemetry } from './core/antibot/telemetry.js';
import { registerAntibot } from './core/antibot/fastify.js';
import { normalizeClientIp } from './core/antibot/ip.js';
import { createResourcePool } from './core/antibot/resources.js';
import { createImageService } from './core/antibot/images.js';
import { createWsProtection } from './core/antibot/ws.js';
import { admitWsUpgrade, attachWsUpgrade } from './core/antibot/ws-admission.js';
import { createHttpResourceGuard, sendRateLimit, sendUnauthenticated } from './core/antibot/http-resources.js';
import { parseSearchInput, safePositiveId, ValidateAlertInput, BoundedInputError, parsePagination, paginateRows } from './core/request-bounds.js';
import { toPublicAlert, toPublicFavorite, toPublicHit, toPublicLot } from './core/public-dto.js';
import { buildMePayload, createAccountContext, VISIBLE_FAVORITE_PREDICATE } from './core/account-context.js';
import { ROUTE_POLICIES, registerChallengeHttp, registerOperationsMetricsRoute } from './core/antibot/routes.js';
import { PAGINA_LOGIN } from './web/login-template.js';
import type { query as DbQuery } from './core/db.js';
import type { Identidade } from './core/identidade.js';
import type { CollectJob } from './queue/runtime.js';

export interface LegacyHostDependencies {
  data: {
    query: typeof DbQuery;
    searchLots: typeof import('./core/repo.js').searchLots;
    searchLotsMapa: typeof import('./core/repo.js').searchLotsMapa;
    getLot: typeof import('./core/repo.js').getLot;
    getStats: typeof import('./core/repo.js').getStats;
    ensureSources: typeof import('./core/repo.js').ensureSources;
    contarCasaveis: typeof import('./core/alerts.js').contarCasaveis;
    avaliarAlertas: typeof import('./core/alerts.js').avaliarAlertas;
  };
  identity: {
    garantirUsuario: typeof import('./core/identidade.js').garantirUsuario;
    identidadePorSub: typeof import('./core/identidade.js').identidadePorSub;
    usuarioDoPortao: typeof import('./core/identidade.js').usuarioDoPortao;
    ANONIMO: typeof import('./core/identidade.js').ANONIMO;
  };
  oidc: {
    oidcLigado: () => boolean;
    iniciarLogin: typeof import('./core/oidc.js').iniciarLogin;
    concluirLogin: typeof import('./core/oidc.js').concluirLogin;
    loginPorSenha: typeof import('./core/oidc.js').loginPorSenha;
    urlDeLogout: typeof import('./core/oidc.js').urlDeLogout;
    COOKIE_OIDC: string;
    COOKIE_PKCE: string;
  };
  jobs: {
    connectors: typeof import('./connectors/index.js').connectors;
    createCollectQueue: (connection: ReturnType<typeof import('./queue/runtime.js').makeRedis>) => ReturnType<typeof import('./queue/runtime.js').createCollectQueue>;
  };
  runtime: {
    makeRedis: typeof import('./queue/runtime.js').makeRedis;
    createAntibotRedis: (url: string) => ReturnType<typeof import('./queue/runtime.js').makeRedis>;
    createWsRedis: (url: string) => ReturnType<typeof import('./queue/runtime.js').makeRedis>;
    CHANNEL_UPDATES: typeof import('./queue/runtime.js').CHANNEL_UPDATES;
    hostsTlsIncomplete: Set<string>;
    createAntibotDriver?: (config: import('./core/antibot/types.js').AntibotConfig) => import('./core/antibot/types.js').RateLimitDriver;
    initialize: () => Promise<void>;
    close: () => Promise<void>;
  };
}
export interface LegacyHostPaths { projectRoot: string; webRoot: string; appDist: string; certDir: string; dataDir: string }
export interface LegacyHostOptions { env: NodeJS.ProcessEnv; paths: LegacyHostPaths; dependencies: LegacyHostDependencies }

export async function createLegacyHost({ env, paths, dependencies }: LegacyHostOptions) {
  if (!dependencies.oidc.oidcLigado()) throw new Error('OIDC obrigatório para iniciar o host.');
  const proxyTrustConfig = loadProxyTrustConfig(env);
  const app = Fastify({ logger: false, trustProxy: proxyTrustConfig.trustedProxyCidrs.length ? [...proxyTrustConfig.trustedProxyCidrs] : false, bodyLimit: 16 * 1024 });
  let closing: Promise<void> | undefined;
  let wsProtection: ReturnType<typeof createWsProtection> | undefined;
  let antibotRedis: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let imageService: ReturnType<typeof createImageService> | undefined;
  let subscriber: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let wsRedis: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let loginRedis: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let redisCadastro: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let collectQueue: ReturnType<typeof dependencies.jobs.createCollectQueue> | undefined;
  let collectQueueConnection: ReturnType<typeof dependencies.runtime.makeRedis> | undefined;
  let insecureSemRedirectAgent: Agent | null = null;
  function insecureSemRedirect(): Agent {
    insecureSemRedirectAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
    return insecureSemRedirectAgent;
  }
  app.addHook('onClose', async () => closing ??= (async () => {
    const failures: unknown[] = [];
    const attempt = async (close: () => unknown | Promise<unknown>) => {
      try { await close(); } catch (error) { failures.push(error); }
    };
    const closeRedis = async (client: { status?: string; quit?: () => Promise<unknown>; disconnect?: () => unknown } | undefined) => {
      if (!client) return;
      try { if (client.status === 'ready') await client.quit?.(); else client.disconnect?.(); }
      catch (error) { try { client.disconnect?.(); } catch {} throw error; }
    };
    // O avvio roda onClose em LIFO: o hook que registerAntibot registra depois já fechou o
    // engine antes deste bloco. engine.close é idempotente, então chamar aqui de novo não
    // repete driver.close — apenas garante o fechamento na agregação de falhas do host.
    await attempt(async () => antibot?.close());
    await attempt(async () => wsProtection?.close());
    await attempt(async () => imageService?.close());
    await attempt(async () => collectQueue?.close());
    await attempt(async () => closeRedis(collectQueueConnection));
    await attempt(async () => closeRedis(subscriber));
    await attempt(async () => closeRedis(loginRedis));
    await attempt(async () => closeRedis(wsRedis));
    await attempt(async () => closeRedis(redisCadastro));
    // Dono único do antibotRedis: o driver montado pelo registro não desconecta cliente
    // injetado (fastify.ts), então quit/disconnect acontecem só aqui, uma única vez.
    await attempt(async () => closeRedis(antibotRedis));
    await attempt(async () => insecureSemRedirectAgent?.close());
    await attempt(() => dependencies.runtime.close());
    if (failures.length) throw new AggregateError(failures, 'Falha ao fechar recursos do host legado.');
  })());
  const query: typeof DbQuery = dependencies.data.query;
  const resourcePool = createResourcePool();
  const { tryAcquireResource, tryAcquireImageJob } = resourcePool;
const certDir = paths.certDir;
const temCert = existsSync(join(certDir, 'local.crt')) && existsSync(join(certDir, 'local.key'));

const antibotConfig = loadAntibotConfig(env);
const challengeConfig = loadChallengeConfig(env);
const telemetry = createOperationsTelemetry({
  antibotMode: antibotConfig.mode,
  challengeMode: challengeConfig.mode,
  proxyTrustConfigured: proxyTrustConfig.trustedProxyCidrs.length > 0,
});
const antibotDriver = dependencies.runtime.createAntibotDriver?.(antibotConfig);
if (antibotConfig.mode !== 'off' && !antibotDriver) {
  antibotRedis = dependencies.runtime.createAntibotRedis(antibotConfig.redisUrl);
}
const challengeService = createChallengeService({ config: challengeConfig });
const challengeObservedService = {
  clientConfig: () => challengeService.clientConfig(),
  async verify(action: Parameters<typeof challengeService.verify>[0], token: unknown) {
    const startedAt = performance.now();
    try {
      const result = await challengeService.verify(action, token);
      telemetry.observeChallenge(action, result.ok ? 'success' : result.kind, performance.now() - startedAt);
      return result;
    } catch (error) {
      telemetry.observeChallenge(action, 'error', performance.now() - startedAt);
      throw error;
    }
  },
};
// Navegação para rota inexistente recebia o JSON cru do Fastify, em inglês. API segue em JSON.
const PAGINA_404 = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Página não encontrada · Radar de Leilões</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;
background:#05070f;color:#eef3ff;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
h1{font-size:24px;margin:0 0 8px}p{color:#93a4c4;margin:0 0 22px}a{display:inline-block;margin:0 6px;padding:11px 18px;
border-radius:10px;text-decoration:none;font-weight:600}.p{background:#2f6bff;color:#fff}.s{border:1px solid #1e2941;color:#eef3ff}</style>
</head><body><main><h1>Esta página não existe</h1><p>O endereço pode ter mudado ou o lote saiu do ar.</p>
<a class="p" href="/busca">Buscar lotes</a><a class="s" href="/">Ir para o início</a></main></body></html>`;
app.setNotFoundHandler((req, reply) => {
  const html = String(req.headers.accept ?? '').includes('text/html');
  if (req.method === 'GET' && html && !req.url.startsWith('/api/')) {
    return reply.code(404).type('text/html; charset=utf-8').send(PAGINA_404);
  }
  return reply.code(404).send({ erro: 'não encontrado', rota: req.url.split('?')[0] });
});

// Erro cru vazava a mensagem do Postgres (código, coluna, tipo) ao cliente.
// 4xx mantém a mensagem (é do próprio app); 5xx vira genérico, com o detalhe no log.
app.setErrorHandler((err: any, req, reply) => {
  const code = err?.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (code >= 500) console.error('[erro]', req.method, req.url.split('?')[0], err?.message);
  const html = String(req.headers.accept ?? '').includes('text/html') && !req.url.startsWith('/api/');
  if (html) return reply.code(code).type('text/html; charset=utf-8').send(PAGINA_404);
  return reply.code(code).send({ erro: code >= 500 ? 'erro interno' : String(err?.message ?? 'erro') });
});

// Cabeçalhos de segurança em tudo. Sem CSP aqui: exige inventário de origens e
// um erro quebraria a página inteira — fica como passo à parte.
// script/style com 'unsafe-inline' porque há script inline (window.__LOTE__,
// JSON-LD) e estilos inline; o ganho real fica em object-src/frame-ancestors/
// connect-src, que barram clickjacking, plugin e exfiltração para fora do site.
const challengeOrigins = challengeService.clientConfig().enabled ? ' https://challenges.cloudflare.com' : '';
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `script-src 'self' 'unsafe-inline'${challengeOrigins}`,
  ...(challengeService.clientConfig().enabled ? ['frame-src https://challenges.cloudflare.com'] : []),
  `connect-src 'self' ws: wss:${challengeOrigins}`,
].join('; ');
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'SAMEORIGIN');
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('content-security-policy', CSP);
  // Resposta com dado de conta não pode ficar em cache compartilhado.
  const routeTemplate = req.routeOptions.url;
  const policy = routeTemplate ? ROUTE_POLICIES[`${req.method.toUpperCase()} ${routeTemplate}`] : undefined;
  if (req.url.startsWith('/api/me') || policy === 'search' || policy === 'detail' || policy === 'mapa') {
    reply.header('cache-control', 'no-store');
  }
  return payload;
});

// Registradas só depois do 404/handler de erro e dos cabeçalhos de segurança:
// rota montada antes disso fica fora do handler e da política de resposta.
registerChallengeHttp(app, challengeObservedService, (reply, file) => reply.sendFile(file));
registerOperationsMetricsRoute(app, telemetry);

// Hook order is intentional: root response handling, IP admission, session auth, account admission.
const antibot = await registerAntibot(app, {
  config: antibotConfig,
  observer: composeOperationsObserver(telemetry, createDefaultObserver()),
  driver: antibotDriver,
  redisClient: antibotRedis,
});
await app.register(formbody);
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

wsRedis = antibotConfig.mode === 'off' ? undefined : dependencies.runtime.createWsRedis(antibotConfig.redisUrl);
const hostWsProtection = createWsProtection({
      mode: antibotConfig.mode,
  environment: antibotConfig.environment,
  redisUrl: antibotConfig.mode === 'off' ? undefined : antibotConfig.redisUrl,
  ownedRedisClient: wsRedis,
  onEvent: (event, outcome) => telemetry.observeWs(event, outcome),
});
wsProtection = hostWsProtection;
const httpResources = createHttpResourceGuard({
  tryAcquireResource,
  acquireDegradedWork: () => antibot.acquireDegradedWork(),
});
const accountContext = createAccountContext(query);
const withReadResources = (handler: (req: any, reply: any) => unknown | Promise<unknown>) =>
  async (req: any, reply: any) => httpResources.run(reply, () => handler(req, reply));
async function awaitQueries<T extends readonly unknown[]>(queries: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(queries);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((item) => (item as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/**
 * IP da conexão, sem aceitar cabeçalho encaminhado do cliente.
 */
const ipDoCliente = (req: any): string => normalizeClientIp(String(req.ip ?? ''));

/**
 * Portão de senha. Só liga quando APP_SENHA existe no ambiente, então o uso
 * local continua sem atrito. O service worker do push precisa passar livre:
 * o navegador o busca sem cookie de sessão e um 302 ali quebraria o push.
 */
const LIVRES = new Set(['/login', '/api/login', '/auth/login', '/auth/callback', '/auth/logout', '/sw.js', '/nopic.svg', '/nopic-imovel.svg', '/ca.crt', '/login-hero.jpg', '/api/security-config', '/challenge.js', '/challenge.css', '/landing-antibot.js', '/landing-antibot.html']);

/**
 * Superfície pública.
 *
 * A landing existe para vender o sistema para quem ainda não tem conta: atrás
 * de senha ela não indexa (o robô leva 302 para /login) e não converte. Então
 * ela e o que ela precisa para se desenhar ficam abertos — e SÓ isso.
 *
 * O catálogo NÃO entra aqui: a vitrine da landing é um endpoint próprio, com
 * resultado limitado e sem busca. Ver o resto dos anúncios exige conta.
 */
const PUBLICAS = new Set([
  '/',
  '/robots.txt',
  '/sitemap.xml',
  // A vitrine é o único endereço de dado aberto, e devolve no máximo 8 lotes.
  '/api/vitrine',
  '/api/espera',
  '/api/cadastro',
  '/api/security-config',
  // O proxy de imagem é o que desenha as fotos da vitrine. Sem ele a landing
  // pública abre com oito placeholders.
  '/api/img',
  '/landing.css',
  '/landing.js',
  '/challenge.js',
  '/challenge.css',
  '/landing-antibot.js',
  '/landing-antibot.html',
  '/cartao.js',
  '/cartao.css',
  '/slug.js',
  '/nopic.svg',
  '/nopic-imovel.svg',
  '/mapa-lotes.jpg',
]);
/**
 * Página de lote também exige sessão. O detalhe não pode ser uma exceção ao
 * portão: além de expor dados, a casca do SPA recebida por anônimo caía em
 * `/busca` quando a API devolvia 401.
 */
const ehPublica = (caminho: string) =>
  PUBLICAS.has(caminho) || caminho.startsWith('/assets/');



// Login e gate de acesso são exclusivamente pelo Keycloak (OIDC). Sem OIDC
// configurado, o site roda aberto — modo de desenvolvimento local.
if (dependencies.oidc.oidcLigado()) {
  app.addHook('onRequest', async (req, reply) => {
    const caminho = req.url.split('?')[0];
    if (LIVRES.has(caminho)) return;
    // Visitante anônimo no catálogo público entra como 'comum': as telas que
    // dependem de papel (coleta, alerta) continuam exigindo sessão. A lista de
    // espera é a única escrita liberada — é o CTA da landing e não lê nada.
    // Público NÃO significa "sessão ignorada": significa "sessão opcional".
    // O atalho rodava antes de ler o cookie, e por isso quem estava LOGADO
    // também era tratado como anônimo na página do lote — ganhava a versão de
    // visitante em vez da gaveta sobre a busca.
    const semSessao = !/(?:^|;)\s*radar_sessao=/.test(String(req.headers.cookie ?? ''));
    if (ehPublica(caminho) && semSessao && (req.method === 'GET' || caminho === '/api/espera' || caminho === '/api/cadastro')) {
      (req as any).papel = 'comum';
      // userId 0: nenhuma linha de users tem esse id, então consulta filtrada
      // por dono devolve vazio em vez de devolver os alertas do administrador.
      (req as any).eu = dependencies.identity.ANONIMO;
      return;
    }
    const cookie = String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];
    const sessao = lerToken(cookie);
    if (sessao.valido && sessao.papel) {
      (req as any).papel = sessao.papel;
      // A identidade resolvida acompanha a requisição: é o `userId` dela que
      // filtra alerts, saved_searches e push_subscriptions por dono.
      // Sessão deslizante: renovar prorroga a janela de OCIOSIDADE, nunca o teto
      // absoluto — `nasceu` viaja igual e assinado, então não há como renovar
      // para sempre.
      if (precisaRenovar(sessao)) {
        reply.header('set-cookie', cookieDeSessao(req, criarToken(sessao.papel, sessao.sub, sessao.nasceu)));
      }
      const eu = sessao.sub ? await dependencies.identity.identidadePorSub(sessao.sub) : await dependencies.identity.usuarioDoPortao(sessao.papel);
      // Sessão assinada apontando para usuário que não existe mais (conta
      // apagada no provedor): melhor mandar para o login do que seguir sem dono.
      if (!eu) {
        if (caminho.startsWith('/api/') || caminho === '/ws') return reply.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized' });
        return reply.code(302).header('location', '/login').send();
      }
      (req as any).eu = eu;
      (req as any).papel = eu.papel;
      return;
    }
    // Cookie presente mas inválido em rota realmente pública: segue como anônimo.
    if (ehPublica(caminho) && req.method === 'GET') {
      (req as any).papel = 'comum';
      (req as any).eu = dependencies.identity.ANONIMO;
      return;
    }
    // API responde 401 em JSON; navegação vai para a tela de senha.
    if (caminho.startsWith('/api/') || caminho === '/ws') {
      return reply.code(401).send({ erro: 'não autenticado' });
    }
    // Leva o destino pretendido: sem isso, quem abre um link de /alertas cai na
    // busca depois de entrar e tem de navegar de novo.
    return reply.code(302).header('location', `/login?de=${encodeURIComponent(req.url)}`).send();
  });

  /**
   * Destino pós-login. Aceita só caminho interno conhecido: um `location` vindo
   * de query string sem validação é redirect aberto — bastaria mandar
   * `/login?de=https://site-falso` para a nossa tela de senha despachar a vítima
   * para lá logo depois de ela digitar a senha.
   */
  const DESTINO_PADRAO = '/busca';
  function destinoSeguro(bruto: unknown): string {
    const v = String(bruto ?? '');
    if (!v.startsWith('/') || v.startsWith('//')) return DESTINO_PADRAO;
    const caminho = v.split('?')[0];
    const permitido =
      caminho === '/' || APP_ROTAS.includes(caminho) ||
      (caminho.startsWith('/lote/') && idDoSlug(caminho.slice(6)) !== null);
    return permitido ? v : DESTINO_PADRAO;
  }
  const escapaAtributo = (v: string) =>
    v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  // Com erro, a tela abre já no formulário (o POST falhou ali); sem erro, na intro.
  const telaLogin = (de: unknown, erro = '') =>
    PAGINA_LOGIN.replace('__DE__', escapaAtributo(destinoSeguro(de))).replace('__ABERTO__', erro ? '1' : '0').replace('__ERRO__', erro);

  app.get('/login', async (req, reply) =>
    reply.type('text/html; charset=utf-8').send(telaLogin((req.query as any)?.de)),
  );

  /**
   * Login por provedor OIDC (Keycloak).
   *
   * O `redirect_uri` é derivado do host da requisição, não de variável fixa,
   * para funcionar em desenvolvimento e produção. O provedor só aceita URIs
   * que estão na allowlist do client, então
   * derivar do host não abre redirecionamento arbitrário.
   */
  const uriDeCallback = (req: any) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
    return `${proto}://${req.headers.host}/auth/callback`;
  };
  const cookieDeSessao = (req: any, valor: string, maxAge = 30 * 24 * 3600) => {
    const seguro = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '') === 'https';
    return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${seguro ? '; Secure' : ''}`;
  };

  app.get('/auth/login', async (req, reply) => {
    if (!dependencies.oidc.oidcLigado()) return reply.code(404).send({ erro: 'OIDC desligado' });
    try {
      const { url, cookie } = await dependencies.oidc.iniciarLogin(uriDeCallback(req), destinoSeguro((req.query as any)?.de));
      return reply
        // O cookie do PKCE vive minutos e é SameSite=Lax porque o provedor
        // devolve a pessoa por navegação de topo — com Strict ele não voltaria.
        .header('set-cookie', `${dependencies.oidc.COOKIE_PKCE}=${cookie}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`)
        .code(302)
        .header('location', url)
        .send();
    } catch (e: any) {
      app.log?.error?.(e);
      return reply.code(502).type('text/html; charset=utf-8').send(
        telaLogin('', `<div class="erro">Provedor de identidade indisponível. Use usuário e senha.</div>`),
      );
    }
  });

  app.get('/auth/callback', async (req, reply) => {
    if (!dependencies.oidc.oidcLigado()) return reply.code(404).send({ erro: 'OIDC desligado' });
    const q = (req.query as any) ?? {};
    const pkce = String(req.headers.cookie ?? '')
      .split(';').map((c) => c.trim().split('=')).find(([k]) => k === dependencies.oidc.COOKIE_PKCE)?.[1];
    // O provedor devolve erro na própria query quando o usuário cancela.
    if (q.error) {
      return reply.code(400).type('text/html; charset=utf-8').send(
        telaLogin('', `<div class="erro">Login cancelado no provedor (${String(q.error).slice(0, 40)}).</div>`),
      );
    }
    try {
      const r = await dependencies.oidc.concluirLogin({ code: String(q.code ?? ''), state: String(q.state ?? ''), cookiePkce: pkce, redirectUri: uriDeCallback(req) });
      const eu = await dependencies.identity.garantirUsuario({ sub: r.sub, email: r.email, nome: r.nome, papel: r.papel });
      return reply
        .header('set-cookie', [
          cookieDeSessao(req, criarToken(eu.papel, eu.sub)),
          `${dependencies.oidc.COOKIE_PKCE}=; Path=/auth; Max-Age=0`,
          `${dependencies.oidc.COOKIE_OIDC}=1; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
        ])
        .code(302)
        .header('location', destinoSeguro(r.destino))
        .send();
    } catch (e: any) {
      app.log?.error?.(e);
      return reply.code(400).type('text/html; charset=utf-8').send(
        telaLogin('', `<div class="erro">Não foi possível concluir o login: ${String(e.message).slice(0, 80)}</div>`),
      );
    }
  });

  /**
   * Sair. Apaga a nossa sessão e, quando a entrada foi por OIDC, encerra também
   * no provedor — sem isso o próximo "Entrar" reautentica em silêncio e o botão
   * de sair parece não funcionar.
   */
  app.get('/auth/logout', async (req, reply) => {
    const cookies = String(req.headers.cookie ?? '');
    const veioDeOidc = /(?:^|;\s*)radar_oidc=1/.test(cookies);
    const limpa = [cookieDeSessao(req, '', 0), `${dependencies.oidc.COOKIE_OIDC}=; Path=/; Max-Age=0`];
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
    let destino = '/login';
    if (veioDeOidc && dependencies.oidc.oidcLigado()) {
      try {
        destino = (await dependencies.oidc.urlDeLogout(`${proto}://${req.headers.host}/login`)) ?? '/login';
      } catch {
        /* provedor fora do ar: a sessão local cai de qualquer forma */
      }
    }
    return reply.header('set-cookie', limpa).code(302).header('location', destino).send();
  });

  /**
   * Freio de força bruta no login.
   *
   * Medido antes disto: dez senhas erradas seguidas devolviam dez 401 sem
   * atraso nenhum. Com uma senha só protegendo o índice inteiro, isso é o furo
   * mais explorável que existia.
   *
   * O contador vive no Redis, não em memória: o processo reinicia a cada edição
   * de código, e um contador que zera no restart não é freio.
   */
  // Conexão própria: a outra do servidor está em modo subscribe, e no ioredis
  // uma conexão inscrita em canal não aceita mais comandos comuns.
  loginRedis = dependencies.runtime.makeRedis();
  const redis = loginRedis;
  const JANELA_S = 900;
  const TETO = 8;
  async function tentativasDe(ip: string): Promise<number> {
    try {
      return Number(await redis.get(`login:falha:${ip}`)) || 0;
    } catch {
      // Redis fora do ar não pode derrubar o login: sem contador, sem freio,
      // mas com o portão ainda funcionando.
      return 0;
    }
  }
  async function registraFalha(ip: string) {
    try {
      const chave = `login:falha:${ip}`;
      const n = await redis.incr(chave);
      if (n === 1) await redis.expire(chave, JANELA_S);
    } catch {
      /* idem */
    }
  }
  const ipDe = ipDoCliente;

  app.post('/api/login', async (req, reply) => {
    const corpo = (req.body ?? {}) as any;
    const ip = ipDe(req);
    if ((await tentativasDe(ip)) >= TETO) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(telaLogin(corpo.de, '<div class="erro">Muitas tentativas. Aguarde 15 minutos.</div>'));
    }
    // Login é só pelo Keycloak (Direct Access Grant): o form é nosso, a
    // identidade é do provedor, sem redirecionar o navegador.
    let u: Awaited<ReturnType<typeof dependencies.oidc.loginPorSenha>>;
    try {
      u = await dependencies.oidc.loginPorSenha(corpo.usuario ?? '', corpo.senha ?? '');
    } catch (e: any) {
      app.log?.error?.(e);
      return reply.code(502).type('text/html; charset=utf-8').send(
        telaLogin(corpo.de, '<div class="erro">Provedor de identidade indisponível. Tente em instantes.</div>'),
      );
    }
    if (!u) {
      await registraFalha(ip);
      // Mensagem única: dizer qual campo errou confirma a um estranho que o usuário existe.
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(telaLogin(corpo.de, '<div class="erro">Usuário ou senha incorretos.</div>'));
    }
    const eu = await dependencies.identity.garantirUsuario({ sub: u.sub, email: u.email, nome: u.nome, papel: u.papel });
    const cookie = criarToken(eu.papel, eu.sub);
    // Acerto zera o contador: senão quem errou 7 vezes e acertou continuaria
    // a um erro do bloqueio pelos 15 minutos seguintes.
    try {
      await redis.del(`login:falha:${ip}`);
    } catch {
      /* sem Redis, sem contador para zerar */
    }
    return reply
      .header('set-cookie', cookieDeSessao(req, cookie))
      .code(302)
      // `/` é a landing de venda e é idêntica antes e depois de entrar: mandar
      // para lá dava a impressão de que o login não tinha funcionado.
      .header('location', destinoSeguro(corpo.de))
      .send();
  });
} else {
  // Sem portão (APP_SENHA vazio) o "Entrar" da landing dava 404: a rota só
  // existia com a senha ligada. Entrar limpa o radar_saiu (volta a ser o dono).
  app.get('/login', async (_req, reply) =>
    reply.header('set-cookie', 'radar_saiu=; Path=/; Max-Age=0').code(302).header('location', '/busca').send(),
  );
  // Logout sem portão não tem sessão para encerrar: marca radar_saiu para o /api/me
  // responder deslogado e a landing mostrar o estado de visitante.
  app.get('/auth/logout', async (_req, reply) =>
    reply
      .header('set-cookie', [`${COOKIE}=; Path=/; Max-Age=0`, 'radar_saiu=1; Path=/; SameSite=Lax'])
      .code(302)
      .header('location', '/')
      .send(),
  );
}
const here = dirname(paths.webRoot);

await app.register(fastifyStatic, { root: join(here, 'web'), prefix: '/', index: false });

/**
 * O app de busca (React/Vite) vive em app-busca/ e é servido daqui.
 *
 * `decorateReply: false` porque o primeiro registro de fastify-static já
 * decorou o reply com sendFile; um segundo registro sem isso derruba o boot
 * com "reply.sendFile already exists".
 */
const APP_DIST = paths.appDist;
const APP_CLIENTE = join(APP_DIST, 'client');
const temAppNovo = existsSync(join(APP_CLIENTE, 'index.html'));
if (temAppNovo) {
  await app.register(fastifyStatic, {
    root: join(APP_CLIENTE, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    // Nome com hash do conteúdo: mudou o arquivo, mudou a URL. Pode cachear
    // forte, sem depender do cache/CDN para servir a versão correta no deploy.
    maxAge: '1y',
    immutable: true,
  });
}

/** Casca do app novo, lida uma vez por requisição para o deploy não exigir restart. */
const cascaDoApp = () => readFileSync(join(APP_CLIENTE, 'index.html'), 'utf8');

/**
 * Render do lote no servidor.
 *
 * O bundle é carregado sob demanda e memorizado: importar a cada requisição
 * refaria o parse de 82 KB por lote aberto, e importar no topo quebraria o boot
 * em ambiente onde o app ainda não foi construído.
 */
let renderLote: ((lot: any, publico?: boolean) => string) | null = null;
async function carregarRender(): Promise<((lot: any, publico?: boolean) => string) | null> {
  if (renderLote) return renderLote;
  try {
    const mod = await import(pathToFileURL(join(APP_DIST, 'server', 'entry-server.js')).href);
    renderLote = mod.renderLote;
    return renderLote;
  } catch (e: any) {
    app.log.error({ err: e.message }, 'SSR do lote indisponível; caindo para a casca');
    return null;
  }
}

/**
 * URLs amigáveis. O app é uma página só, então toda rota de navegação devolve
 * a mesma casca e o cliente decide o que mostrar pelo caminho. Sem isto, abrir
 * /alertas direto (ou recarregar com o drawer aberto) dava 404 do estático.
 */
const APP_ROTAS = ['/busca', '/alertas', '/favoritos', '/cobertura'];

/**
 * A URL do estático carrega a data de modificação. `cache-control: max-age=0`
 * com ETag não basta: uma camada de cache externa pode cachear .js e .css por
 * conta própria e servir versão velha por horas.
 * Mudando a URL, nenhuma camada de cache tem o que reaproveitar.
 */
const ESTATICOS = ['slug.js', 'cartao.js', 'landing.js', 'landing.css', 'cartao.css'];
/** Origem pública do site, usada em canonical, Open Graph, JSON-LD e sitemap. */
const SITE = (env.SITE_URL ?? 'http://localhost:4500').replace(/\/$/, '');

/**
 * Origem absoluta desta requisição.
 *
 * `SITE_URL` não está definido em desenvolvimento, e o padrão `localhost:4500`
 * ia parar dentro do og:image — que o robô do WhatsApp não alcança, então o
 * preview vinha sem foto mesmo com a meta presente. O host da requisição é o
 * endereço por onde o visitante REALMENTE chegou, e é ele que serve para
 * montar URL absoluta.
 *
 * `SITE_URL` continua vencendo quando configurado: em produção a origem
 * canônica é decisão nossa, não do cabeçalho que o cliente mandou.
 */
function origemDe(req: any): string {
  if (env.SITE_URL) return SITE;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  if (!host || !/^[a-z0-9.\-:]+$/i.test(host)) return SITE;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

function paginaVersionada(arquivo: string): string {
  let html = readFileSync(join(here, 'web', arquivo), 'utf8').replaceAll('__SITE__', SITE);
  for (const nome of ESTATICOS) {
    const v = Math.floor(statSync(join(here, 'web', nome)).mtimeMs).toString(36);
    html = html.replaceAll(`"/${nome}"`, `"/${nome}?v=${v}"`);
  }
  return html;
}
const enviaPagina = (arquivo: string) => async (_req: any, reply: any) =>
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(paginaVersionada(arquivo));

// A landing de venda ocupa a raiz. A /home (carrosséis do índice) era tela
// morta e foi removida em 17/09; quem chegava nela ia para a busca de qualquer
// jeito, e mantê-la significava um terceiro renderizador de cartão para
// divergir dos outros dois.
app.get('/', enviaPagina('landing-antibot.html'));
/**
 * As rotas de navegação devolvem a casca do app React, que decide a tela pelo
 * caminho. Sem o build não há tela: é erro de implantação, e 503 com a causa
 * escrita é melhor do que servir uma versão antiga que ninguém mandou servir.
 */
for (const rota of APP_ROTAS) {
  app.get(rota, async (_req, reply) =>
    temAppNovo
      ? reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(cascaDoApp())
      : reply.code(503).type('text/plain; charset=utf-8').send('app-busca não construído: rode `npm run build` em app-busca/'),
  );
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const dinheiroBR = (v: number | null) =>
  v == null ? null : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

/**
 * A página do lote é o que traz busca orgânica de cauda longa ("honda civic
 * 2018 leilão"), e ela é uma casca de SPA: o robô de busca lê o HTML, não o
 * resultado do fetch. Por isso o título, a descrição e o JSON-LD do lote são
 * injetados no servidor. O conteúdo visível continua sendo montado no cliente.
 */
app.get<{ Params: { slug: string } }>('/lote/:slug', withReadResources(async (req, reply) => {
  if (!temAppNovo) {
    return reply.code(503).type('text/plain; charset=utf-8').send('app-busca não construído');
  }
  const slug = req.params.slug;
  const id = idDoSlug(slug);
  // O SSR renderiza a gaveta inteira, então precisa do MESMO objeto que
  // /api/lot/:id entrega — o SELECT curto de antes só servia para montar meta,
  // e renderizar com menos campos aqui do que o cliente tem faria a hidratação
  // divergir campo a campo.
  const lot = id !== null ? await dependencies.data.getLot(id) : null;
  // Nunca entrega a casca do SPA numa URL inválida: ela poderia montar a busca
  // mantendo `/lote/<id>` na barra. O destino canônico de rota/lote inexistente
  // é a busca.
  if (!lot) return reply.code(302).header('location', '/busca').header('cache-control', 'no-store').send();
  // Não revelar o lote nem sua URL correta quando só o ID corresponde.
  if (slug !== slugDoLote(lot)) {
    return reply.code(404).header('cache-control', 'no-store').send({ erro: 'Lote não encontrado.' });
  }
  const eu = await donoDe(req);
  const lotForRender = (await accountContext.decorateLots(eu.userId, [toPublicLot(lot)]))[0];
  const html = cascaDoApp();

  const titulo = lotForRender.title_display || lotForRender.title_raw;
  const local = [lotForRender.city, lotForRender.state].filter(Boolean).join('/');
  const lance = dinheiroBR(lotForRender.current_bid ?? lotForRender.min_bid);
  const bem = lotForRender.asset_type === 'imovel' ? 'Imóvel' : 'Veículo';
  const descricao = [
    `${bem} em leilão: ${titulo}.`,
    local ? `Local: ${local}.` : '',
    lance ? `Lance ${lot.current_bid != null ? 'atual' : 'mínimo'}: ${lance}.` : 'Sem lance publicado.',
    'Prazo e link direto para o site do leiloeiro no Radar de Leilões.',
  ].filter(Boolean).join(' ');
  const origem = origemDe(req);
  const foto = lotForRender.photos?.[0] ? `${origem}/api/img?u=${encodeURIComponent(lotForRender.photos[0])}&w=1200` : '';

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: titulo,
    description: descricao,
    ...(foto ? { image: foto } : {}),
    ...(lotForRender.brand ? { brand: { '@type': 'Brand', name: lotForRender.brand } } : {}),
    offers: {
      '@type': 'Offer',
      priceCurrency: 'BRL',
      // O lance corrente é o preço que existe hoje; a avaliação não é preço de venda.
       ...(lotForRender.current_bid ?? lotForRender.min_bid ? { price: String(lotForRender.current_bid ?? lotForRender.min_bid) } : {}),
      availability: 'https://schema.org/InStock',
      url: `${origem}/lote/${slug}`,
       ...(lotForRender.auction_end_utc ? { priceValidUntil: new Date(lotForRender.auction_end_utc).toISOString().slice(0, 10) } : {}),
       ...(lotForRender.auctioneer_name ? { seller: { '@type': 'Organization', name: lotForRender.auctioneer_name } } : {}),
    },
  };

  const cabeca = [
    `<title>${esc(titulo)}${local ? ` em ${esc(local)}` : ''} — leilão | Radar de Leilões</title>`,
    `<meta name="description" content="${esc(descricao)}">`,
    `<link rel="canonical" href="${origem}/lote/${esc(slug)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${esc(titulo)}">`,
    `<meta property="og:description" content="${esc(descricao)}">`,
    foto ? `<meta property="og:image" content="${esc(foto)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(jsonld).replaceAll('<', '\\u003c')}</script>`,
  ].filter(Boolean).join('\n');

  /**
   * As metas do lote SUBSTITUEM as do template, não convivem com elas.
   *
   * O index.html do app traz og:title/og:description genéricos ("Radar de
   * Leilões"), e injetar as do lote sem tirar aquelas deixava DUAS de cada no
   * head — o robô escolhe uma, e não há garantia de qual. O preview do WhatsApp
   * era a prova de fogo disso.
   */
  let corpo = html
    .replace(/<meta\s+name="description"[^>]*>/gi, '')
    .replace(/<meta\s+property="og:(title|description|type|image|url)"[^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/, cabeca);

  // SSR de verdade: o robô recebe o lote já renderizado no HTML, e o cliente
  // hidrata sobre a mesma árvore com o mesmo objeto em `window.__LOTE__`.
  // Falha no render NÃO derruba a página: cai na casca e o cliente busca o
  // lote sozinho, que é exatamente o comportamento anterior.
  // Anônimo (o robô do WhatsApp, quem recebeu o link) vê a página do lote e o
  // convite para entrar — não a busca, que exige conta e devolveria 401 em todo
  // fetch do cliente.
  // Página pública é só para anônimo real. Sem portão (dev) o hook de auth não
  // roda e papel fica null: tratar isso como público jogava o lote recarregado
  // na página pública com "Entrar", mesmo sendo o dono logado.
  const publico = dependencies.oidc.oidcLigado() && (req as any).eu === dependencies.identity.ANONIMO;
  // O HTML vai para qualquer um (a página do lote é pública). O cliente não usa
  // `raw` nem os campos de verificação, então eles não vão no __LOTE__: `raw`
  // carrega nº de processo judicial de algumas fontes, e o resto é interno.
  const loteSeguro = lotForRender;
  const render = temAppNovo ? await carregarRender() : null;
  if (render) {
    try {
      const marcado = render(loteSeguro, publico);
      /**
       * O React 19 emite `<link rel="preload">` para as fotos do lote. São
       * elementos HOISTABLE: pertencem ao `<head>`, e o `renderToString`
       * devolve todos no meio da marcação porque não tem documento para
       * hoistá-los.
       *
       * Injetar isso dentro de `<div id="root">` quebrava a hidratação com
       * React #418 — o servidor mandava um `<link>` que o cliente não
       * renderiza ali. Mover para o head conserta a hidratação E é o lugar
       * certo: o navegador começa a baixar a foto antes de avaliar o bundle.
       */
      const preloads: string[] = [];
      const html = marcado.replace(/<link\b[^>]*\brel="(?:preload|preconnect|dns-prefetch|stylesheet)"[^>]*>/g, (m) => {
        preloads.push(m);
        return '';
      });
      // `</script` dentro do JSON fecharia a tag e viraria injeção de HTML a
      // partir de um título escrito pelo leiloeiro.
      const estado = JSON.stringify(loteSeguro).replaceAll('<', '\\u003c');
      corpo = corpo
        .replace('<div id="root"></div>', `<div id="root">${html}</div>`)
        .replace(
          '</head>',
          `${preloads.join('')}<script>window.__LOTE__=${estado};window.__PUBLICO__=${publico}</script></head>`,
        );
    } catch (e: any) {
      app.log.error({ err: e.message, lote: id }, 'SSR do lote falhou; servindo a casca');
    }
  }

  return reply.type('text/html; charset=utf-8').header('cache-control', 'private, no-store').send(corpo);
}));

/**
 * Sem robots.txt e sitemap o buscador só acha o que estiver linkado na home —
 * e o valor do índice está justamente nas 21 mil páginas de lote.
 */
app.get('/robots.txt', async (_req, reply) =>
  reply.type('text/plain; charset=utf-8').send(
    [
      'User-agent: *',
      // A foto do lote é servida pela nossa origem, então o og:image aponta para
      // /api/img. Bloquear /api/ inteiro tiraria a imagem do resultado de busca.
      'Allow: /api/img',
      'Disallow: /api/',
      'Disallow: /login',
      // Exigem conta: rastrear leva a 302 e não produz página indexável.
      'Disallow: /busca',
      'Disallow: /alertas',
      'Disallow: /cobertura',
      'Disallow: /lote/',
      'Allow: /',
      '',
      `Sitemap: ${SITE}/sitemap.xml`,
      '',
    ].join('\n'),
  ),
);

app.get('/sitemap.xml', async (_req, reply) => {
  // Só a landing entra. As 22 mil páginas de lote exigem conta agora, e
  // anunciar no sitemap URL que responde 302 para /login é pior do que não
  // anunciar: o buscador gasta rastreio e marca o site como cheio de redirect.
  //
  // O custo dessa decisão é a cauda longa ("honda civic 2018 leilão"), que era
  // justamente o que a meta por lote renderizada no servidor ia capturar.
  const corpo = [...PUBLICAS]
    .filter((r) => !r.startsWith('/api/') && !/\.(css|js|svg|txt|xml)$/.test(r))
    .map((r) => `<url><loc>${SITE}${r === '/' ? '/' : r}</loc><priority>${r === '/' ? '1.0' : '0.7'}</priority></url>`)
    .join('');
  return reply
    .type('application/xml; charset=utf-8')
    .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${corpo}</urlset>`);
});

/**
 * Conteúdo da landing: últimos lotes mapeados e o recorte por leiloeiro.
 * Uma chamada só — duas seriam duas idas ao banco para pintar a mesma tela.
 */
/**
 * A home desenha o MESMO cartão da busca, então precisa das mesmas colunas
 * calculadas. Quando ela tinha SELECT próprio, faltavam title_display,
 * discount_pct e bid_suspect e o cartão degradava sem erro nenhum.
 */
const COLUNAS_CARTAO = `id, title_raw, title_display, source_id, asset_type, vehicle_type, property_type,
            source_category, status, city, state, km, doc_type, photos, brand, model, year_make, year_model,
            current_bid, min_bid, appraisal, bid_suspect, auction_end_utc, auction_start_utc, closing_model,
            auctioneer_name,
            COALESCE((raw->>'areaPrivativa')::numeric, (raw->>'areaTotal')::numeric, (raw->>'areaTerreno')::numeric) AS area,
            (raw->>'quartos')::int AS rooms,
            first_seen_at > now() - interval '24 hours' AS is_novo,
            CASE WHEN appraisal > 0 AND COALESCE(current_bid,min_bid) > 0
                 THEN ROUND((1 - COALESCE(current_bid,min_bid)/appraisal) * 100) ELSE NULL END AS discount_pct`;

app.get('/api/home', withReadResources(async (req) => {
  const [recentes, leiloeiros] = await awaitQueries([
    query(
      `SELECT ${COLUNAS_CARTAO}
         FROM lots
        WHERE status IN ('aberto','agendado') AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
        ORDER BY first_seen_at DESC, id DESC
        LIMIT 24`,
    ),
    query(
      `SELECT auctioneer_name AS nome, count(*)::int AS total
         FROM lots
        WHERE auctioneer_name IS NOT NULL AND auctioneer_name <> ''
          AND status IN ('aberto','agendado')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    ),
  ]);
  const [[{ fontes, total, totalLeiloeiros }], ufs] = await awaitQueries([
    query<{ fontes: number; total: number; totalLeiloeiros: number }>(
      `SELECT count(DISTINCT source_id)::int AS fontes, count(*)::int AS total,
              (SELECT count(*)::int FROM auctioneers WHERE domain IS NOT NULL AND domain <> '') AS "totalLeiloeiros"
         FROM lots WHERE status IN ('aberto','agendado','sem_data')`,
    ),
    query<{ uf: string; total: number }>(
      `SELECT state AS uf, count(*)::int AS total
         FROM lots WHERE state IS NOT NULL AND status IN ('aberto','agendado','sem_data')
        GROUP BY 1 ORDER BY 2 DESC`,
    ),
  ]);
  const eu = await donoDe(req);
  const recentesPublicos = await accountContext.decorateLots(eu.userId, recentes.map(toPublicLot));
  return { recentes: recentesPublicos, leiloeiros, fontes, total, totalLeiloeiros, ufs };
}));

/**
 * Conteúdo da landing de venda numa chamada só.
 *
 * Todo número que a landing mostra sai daqui. O mockup do design trazia
 * "21.943 lotes" e "116 leiloeiros" escritos no HTML — número chumbado em
 * landing de agregador vira mentira no mesmo dia.
 */
/**
 * Vitrine pública da landing.
 *
 * É o ÚNICO endereço de dado aberto, e por isso tem teto rígido: 8 lotes, 12
 * leiloeiros, contagens agregadas. Não aceita termo de busca, filtro nem
 * paginação — quem quiser percorrer o catálogo entra na conta. Era essa a
 * diferença entre "landing pública" e "índice público".
 */
const TETO_VITRINE = 8;

app.get('/api/vitrine', withReadResources(async () => {
  const ABERTOS = `status IN ('aberto','agendado','sem_data')`;
  // As categorias são as do índice de verdade, com a mesma query que o filtro da
  // busca usa — assim o número do cartão e o resultado do clique não divergem.
  const CATEGORIAS = [
    { id: 'carro', label: 'Carros', icone: 'carro', query: 'vehicleType=carro', onde: `vehicle_type='carro'` },
    { id: 'suv', label: 'SUVs', icone: 'carro', query: 'vehicleType=suv', onde: `vehicle_type='suv'` },
    { id: 'moto', label: 'Motos', icone: 'moto', query: 'vehicleType=moto', onde: `vehicle_type='moto'` },
    { id: 'picape', label: 'Picapes', icone: 'caminhao', query: 'vehicleType=picape', onde: `vehicle_type='picape'` },
    { id: 'caminhao', label: 'Caminhões', icone: 'caminhao', query: 'vehicleType=caminhao', onde: `vehicle_type='caminhao'` },
    { id: 'imovel', label: 'Imóveis', icone: 'casa', query: 'assetType=imovel', onde: `asset_type='imovel'` },
  ];

  const [agregados, ufs, categorias, leiloeiros, recentes, encerrando, porHora, fotosCat, heroes] = await awaitQueries([
    query<any>(
      `SELECT count(DISTINCT source_id)::int AS fontes,
              count(*)::int AS total,
              (SELECT count(*)::int FROM auctioneers WHERE domain IS NOT NULL AND domain <> '') AS "totalLeiloeiros",
              count(*) FILTER (WHERE first_seen_at > now() - interval '24 hours')::int AS "novos24h",
              count(*) FILTER (WHERE closing_model = 'timer_por_lote'
                               AND auction_end_utc BETWEEN now() AND now() + interval '24 hours')::int AS "encerram24h"
         FROM lots WHERE ${ABERTOS}`,
    ),
    query<any>(
      `SELECT state AS uf, count(*)::int AS total FROM lots
        WHERE state IS NOT NULL AND ${ABERTOS} GROUP BY 1 ORDER BY 2 DESC`,
    ),
    query<any>(
      `SELECT ${CATEGORIAS.map((c, i) => `count(*) FILTER (WHERE ${c.onde})::int AS c${i}`).join(', ')}
         FROM lots WHERE ${ABERTOS}`,
    ),
    query<any>(
      `SELECT auctioneer_name AS nome, count(*)::int AS total FROM lots
        WHERE auctioneer_name IS NOT NULL AND auctioneer_name <> '' AND ${ABERTOS}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    ),
    query<any>(
      // No máximo 2 por fonte: os 8 mais recentes vinham todos do Leilo, que não
      // publica leiloeiro, e a vitrine da landing mostrava uma fonte só — sem
      // crédito de foto e sem dar ideia da largura do índice.
      `SELECT ${COLUNAS_CARTAO} FROM (
         SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY first_seen_at DESC, id DESC) AS n
           FROM lots
          WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
       ) t WHERE n <= 2 ORDER BY first_seen_at DESC, id DESC LIMIT ${TETO_VITRINE}`,
    ),
    // Só timer por lote entra no painel: pregão em horário marcado não tem fim
    // por lote, e enfileirar os dois ali seria prometer prazo que a fonte não dá.
    query<any>(
      `SELECT id, title_display, title_raw, city, state, current_bid, min_bid, auction_end_utc
         FROM lots
        WHERE status IN ('aberto','agendado') AND closing_model = 'timer_por_lote'
          AND auction_end_utc > now()
        ORDER BY auction_end_utc ASC LIMIT 5`,
    ),
    query<any>(
      `SELECT h, count(l.id)::int AS total
         FROM generate_series(1, 12) AS h
         LEFT JOIN lots l
           ON l.closing_model = 'timer_por_lote'
          AND l.status IN ('aberto','agendado')
          AND l.auction_end_utc >= now() + (h - 1) * interval '1 hour'
          AND l.auction_end_utc <  now() + h * interval '1 hour'
        GROUP BY h ORDER BY h`,
    ),
    // Uma foto por categoria, a mais recente: o cartão da categoria mostra um lote de verdade.
    query<any>(
      `SELECT DISTINCT ON (cat) cat, photos->>0 AS foto FROM (
         SELECT CASE WHEN asset_type = 'imovel' THEN 'imovel' ELSE vehicle_type END AS cat, photos, first_seen_at, id
           FROM lots WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
       ) t WHERE cat IN (${CATEGORIAS.map((c) => `'${c.id}'`).join(',')})
       ORDER BY cat, first_seen_at DESC, id DESC`,
    ),
    // heroes: lotes aptos ao card flutuante — o filtro de preço obrigatório
    // evita que lotes sem campo de lance (parquedosleiloes) roubem a pilha.
    query<any>(
      `SELECT ${COLUNAS_CARTAO} FROM (
         SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY first_seen_at DESC, id DESC) AS n
           FROM lots
          WHERE ${ABERTOS} AND photos IS NOT NULL AND jsonb_array_length(photos) > 0
            AND (current_bid IS NOT NULL OR min_bid IS NOT NULL) AND NOT bid_suspect
       ) t WHERE n <= 2 ORDER BY first_seen_at DESC, id DESC LIMIT 3`,
    ),
  ]);
  const c = categorias[0] ?? {};
  const emQuanto = (fim: string) => {
    const dif = new Date(fim).getTime() - Date.now();
    const min = Math.max(0, Math.round(dif / 60000));
    if (min < 1) return 'encerrando agora';
    if (min < 60) return `encerra em ${min} min`;
    const h = Math.floor(min / 60);
    return h < 24 ? `encerra em ${h}h ${min % 60}min` : `encerra em ${Math.floor(h / 24)}d`;
  };

  return {
    ...agregados[0],
    ufs,
    leiloeiros,
    recentes: recentes.map(toPublicLot),
    heroes: heroes.map(toPublicLot),
    categorias: CATEGORIAS.map(({ onde: _onde, ...rest }, i) => ({
      ...rest,
      total: c[`c${i}`] ?? 0,
      foto: fotosCat.find((f: any) => f.cat === rest.id)?.foto ?? null,
    })),
    encerrando: encerrando.map((l: any) => ({ ...l, quando: emQuanto(l.auction_end_utc) })),
    porHora: porHora.map((r: any) => r.total),
  };
}));

/**
 * Lista de espera. O e-mail é de terceiro, então o registro guarda junto o texto
 * de consentimento que a pessoa leu — sem isso não há como demonstrar a base
 * legal depois, e o dado vira passivo em vez de ativo.
 */
app.post('/api/espera', withReadResources(async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = String(b.email ?? '').trim().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return reply.code(400).send({ erro: 'e-mail inválido' });
  }
  const consentimento = String(b.consentimento ?? '').trim().slice(0, 2000);
  if (!consentimento) return reply.code(400).send({ erro: 'consentimento ausente' });

  const linhas = await query<{ id: number }>(
    `INSERT INTO espera (email, nome, interesse, consentimento)
     VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4)
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING id`,
    [email, String(b.nome ?? '').trim().slice(0, 120), String(b.interesse ?? '').trim().slice(0, 40), consentimento],
  );
  // Resposta única: `jaEstava` revelava a um estranho se um e-mail já estava na
  // lista. ON CONFLICT DO NOTHING cuida do reenvio sem duplicar.
  void linhas;
  return { ok: true };
}));

/**
 * Cadastro de assinante. Cartão não passa por aqui: o pagamento é na fatura
 * hospedada do ASAAS. Rota pública e sem log de corpo (CPF e celular são PII).
 */
const CADASTRO_TETO = 10;
const CADASTRO_JANELA_S = 3600;
// Fail-open com prazo: o ioredis aqui não desiste de comando pendente, e Redis
// fora do ar não pode travar o cadastro.
async function cadastroLimitado(ip: string): Promise<boolean> {
  try {
    redisCadastro ??= dependencies.runtime.makeRedis();
    const r = redisCadastro;
    const chave = `cadastro:tentativa:${ip}`;
    const n = await Promise.race([
      r.incr(chave).then(async (v) => (v === 1 ? (await r.expire(chave, CADASTRO_JANELA_S), v) : v)),
      new Promise<number>((res) => setTimeout(() => res(0), 800)),
    ]);
    return n > CADASTRO_TETO;
  } catch {
    return false;
  }
}

app.post('/api/cadastro', withReadResources(async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const falha = (campo: string, erro: string) => reply.code(400).send({ erro, campo });

  const ip = ipDoCliente(req);
  if (antibotConfig.mode !== 'enforce' && await cadastroLimitado(ip)) {
    return reply.code(429).send({ erro: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const nome = texto(b.nome, 120).replace(/\s+/g, ' ');
  if (nome.length < 3 || nome.split(' ').length < 2) {
    return falha('nome', 'Informe seu nome completo.');
  }
  const doc = documento(b.documento);
  if (!doc) return falha('documento', 'CPF ou CNPJ inválido.');
  const email = texto(b.email, 200).toLowerCase();
  if (!emailValido(email)) return falha('email', 'E-mail inválido.');
  const celular = celularValido(b.celular);
  if (!celular) return falha('celular', 'Celular inválido. Informe o DDD e o número.');
  const consentimento = texto(b.consentimento, 2000);
  const versao = texto(b.consentimentoVersao, 40);
  if (!consentimento || !versao) {
    return falha('consentimento', 'É preciso aceitar os termos para continuar.');
  }

  const linhas = await query<{ id: string }>(
    `INSERT INTO cadastros
       (nome, cpf_cnpj, tipo_documento, email, celular,
        consentimento_termos_em, consentimento_versao, consentimento_texto,
        consentimento_ip, consentimento_marketing, origem)
     VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8,$9, NULLIF($10,''))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [nome, doc.digitos, doc.tipo, email, celular, versao, consentimento, ip || null, b.marketing === true, texto(b.origem, 40)],
  );
  // Anti-enumeração: dado já cadastrado devolve a MESMA resposta do sucesso, sem
  // id nem o campo em conflito. Antes, o 409 com `campo` dizia a um estranho se
  // um CPF/e-mail existia na base. ON CONFLICT DO NOTHING já evita duplicar.
  // ASAAS: criar customer + subscription a partir de linhas[0]?.id quando novo.
  return reply.code(201).send({
    ok: true,
    proximoPasso: 'pagamento',
    mensagem: 'Cadastro recebido. Em seguida você recebe o link para ativar a assinatura de R$ 69,90/mês.',
  });
}));

app.get('/api/home/leiloeiro', withReadResources(async (req, reply) => {
  const queryInput = req.query as Record<string, unknown>;
  if (Array.isArray(queryInput.nome) || (queryInput.nome !== undefined && typeof queryInput.nome !== 'string')) return reply.code(400).send({ error: 'nome inválido' });
  const nome = String(queryInput.nome ?? '').trim();
  if (!nome) return reply.code(400).send({ erro: 'informe o leiloeiro' });
  const lots = await query(
    `SELECT ${COLUNAS_CARTAO}
       FROM lots
      WHERE auctioneer_name = $1 AND status IN ('aberto','agendado')
      ORDER BY (photos IS NOT NULL AND jsonb_array_length(photos) > 0) DESC, first_seen_at DESC
      LIMIT 24`,
    [nome],
  );
  const eu = await donoDe(req);
  return accountContext.decorateLots(eu.userId, lots.map(toPublicLot));
}));

app.get('/api/search', withReadResources(async (req) => {
  const result = await dependencies.data.searchLots(parseSearchInput(req.query));
  const eu = await donoDe(req);
  return { ...result, items: await accountContext.decorateLots(eu.userId, result.items) };
}));

/**
 * Malha territorial do IBGE, servida daqui porque o desenho do mapa não pode
 * depender de terceiro no caminho crítico. `uf` sempre; `municipio` só quando o
 * usuário aproxima, e são 2,3 MB — nunca no carregamento inicial.
 */
app.get('/api/malha/:tipo', withReadResources(async (req, reply) => {
  const { tipo } = req.params as { tipo: string };
  if (tipo !== 'uf' && tipo !== 'municipio') return reply.code(404).send({ error: 'malha desconhecida' });
  const arq = join(paths.dataDir, 'geo', `${tipo}.json`);
  if (!existsSync(arq)) return reply.code(404).send({ error: 'malha ausente' });
  return reply.header('cache-control', 'public, max-age=604800, immutable').type('application/json').send(readFileSync(arq));
}));

app.get('/api/search/mapa', withReadResources(async (req) => dependencies.data.searchLotsMapa(parseSearchInput(req.query))));

app.get('/api/lot/:id', withReadResources(async (req, reply) => {
  const { id } = req.params as { id: string };
  const lotId = safePositiveId(id);
  if (lotId === null) return reply.code(400).send({ error: 'id inválido' });
  const lot = await dependencies.data.getLot(lotId);
  if (!lot) return reply.code(404).send({ error: 'lote não encontrado' });
  const eu = await donoDe(req);
  return (await accountContext.decorateLots(eu.userId, [lot]))[0];
}));

/**
 * O dono da requisição. Sem portão de senha o modo local segue aberto e tudo
 * pertence à conta administradora — é o comportamento de sempre no localhost.
 */
const donoDe = async (req: any): Promise<Identidade> =>
  (req.eu as Identidade) ?? (await dependencies.identity.usuarioDoPortao(dependencies.oidc.oidcLigado() ? 'comum' : 'admin'));

/** Sem portão de senha, não há papel: o modo local continua aberto como sempre. */
const papelDe = (req: any): Papel => (dependencies.oidc.oidcLigado() ? ((req.papel as Papel) ?? 'comum') : 'admin');

/** O cliente não decide o próprio papel: ele pergunta, e a resposta vem do cookie assinado. */
app.get('/api/me', withReadResources(async (req) => {
  const eu = await donoDe(req);
  // `logado` é a verdade única para o cliente decidir menu/sessão. Com OIDC,
  // logado = tem conta (id>0). Sem OIDC (dev) todo visitante é admin, então o
  // "Sair" marca radar_saiu e o dev consegue ver o estado deslogado.
  const saiuEmDev = !dependencies.oidc.oidcLigado() && /(?:^|;)\s*radar_saiu=1/.test(String(req.headers.cookie ?? ''));
  const logado = dependencies.oidc.oidcLigado() ? eu.userId > 0 : !saiuEmDev;
  const identity = {
    papel: papelDe(req),
    oidc: dependencies.oidc.oidcLigado(),
    logado,
    conta: {
      id: logado ? eu.userId : 0, email: eu.email, nome: eu.nome, porProvedor: eu.sub != null,
    },
  };
  const summary = logado ? await accountContext.summarize(eu.userId) : { favoriteCount: 0, unreadAlertCount: 0 };
  return buildMePayload(identity, summary);
}));

/**
 * Esconder a aba no cliente não protege nada: basta abrir o DevTools e chamar a
 * rota. O portão que vale é este, no servidor. 403 e não 401 — quem chega aqui
 * está autenticado, só não tem permissão.
 */
function exigeAdmin(req: any, reply: any): boolean {
  if (papelDe(req) === 'admin') return false;
  reply.code(403).send({ erro: 'requer administrador' });
  return true;
}

app.get('/api/stats', async (req, reply) => (exigeAdmin(req, reply) ? undefined : dependencies.data.getStats()));

/* ---------------- alertas ---------------- */

app.get('/api/alerts', withReadResources(async (req) => {
  const eu = await donoDe(req);
  const { page, pageSize, offset } = parsePagination((req.query as any)?.page, (req.query as any)?.pageSize);
  const [{ total }] = await query<{ total: number }>('SELECT count(*)::int AS total FROM alerts WHERE owner_id = $1', [eu.userId]);
  const rows = await query(
    `SELECT a.id, a.label, a.q, a.channels, a.email,
            (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id) AS total,
            (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id AND NOT h.seen) AS nao_vistos
       FROM alerts a WHERE a.owner_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`,
    [eu.userId, pageSize + 1, offset],
  );
  const pageRows = paginateRows(rows, page, pageSize);
  return { ...pageRows, items: pageRows.items.map(toPublicAlert), total };
}));

app.post('/api/alerts', withReadResources(async (req, reply) => {
  const b = ValidateAlertInput(req.body);
  const q = b.q?.trim() ?? '';
  const filters = b.filters ?? {};
  const canais = b.channels ?? ['sino'];
  const [a] = await query<any>(
    `INSERT INTO alerts (label, q, filters, channels, email, owner_id) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, label, q, channels, email`,
    [b.label ?? (q || 'Alerta'), q || null, JSON.stringify(filters), canais, b.email ?? null, (await donoDe(req)).userId],
  );
  /**
   * NÃO casa contra o passado.
   *
   * A versão anterior varria 7 dias de lotes e gravava disparo de tudo que
   * achasse, com a intenção de "não nascer vazio". O efeito medido foi outro:
   * um alerta criado às 03:45 aparecia na mesma hora com três lotes que
   * entraram na base 12 horas antes — o usuário lê isso como aviso de novidade,
   * e não era novidade nenhuma.
   *
   * O contador continua, porque a informação é útil, mas é só contagem: os
   * lotes atuais não viram disparo. O que aparecer na aba de alertas entrou
   * DEPOIS do alerta existir.
   */
  const casaveis = await dependencies.data.contarCasaveis(a);
  return { ...toPublicAlert({ ...a, total: 0, nao_vistos: 0 }), casados_agora: 0, no_indice_agora: casaveis };
}));

app.patch('/api/alerts/:id', withReadResources(async (req, reply) => {
  const { id } = req.params as { id: string };
  const alertId = safePositiveId(id);
  if (alertId === null) return reply.code(400).send({ erro: 'id inválido' });
  const b = ValidateAlertInput(req.body, { edit: true });
  const canais = b.channels ?? ['sino'];
  // owner_id no WHERE, igual ao DELETE: sem ele, qualquer um editava o alerta de outro.
  const dono = (await donoDe(req)).userId;
  const [a] = await query<any>(
    `UPDATE alerts SET label = COALESCE($2, label), channels = $3, email = $4 WHERE id = $1 AND owner_id = $5
     RETURNING id, label, q, channels, email`,
    [alertId, b.label ?? null, canais, b.email ?? null, dono],
  );
  if (!a) return reply.code(404).send({ erro: 'alerta não encontrado' });
  const [{ total = 0, nao_vistos = 0 } = {}] = await query<any>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT seen)::int AS nao_vistos FROM alert_hits WHERE alert_id = $1`, [alertId]);
  return toPublicAlert({ ...a, total, nao_vistos });
}));

app.delete('/api/alerts/:id', withReadResources(async (req, reply) => {
  const { id } = req.params as { id: string };
  const alertId = safePositiveId(id);
  if (alertId === null) return reply.code(400).send({ erro: 'id inválido' });
  // O dono entra no WHERE, não numa checagem antes: com a verificação separada
  // existe a janela entre ler e apagar, e um 404 honesto é melhor que um 403
  // que confirma a existência do alerta de outra pessoa.
  const apagados = await query<{ id: string }>(
    'DELETE FROM alerts WHERE id = $1 AND owner_id = $2 RETURNING id',
    [alertId, (await donoDe(req)).userId],
  );
  if (!apagados.length) return reply.code(404).send({ erro: 'alerta não encontrado' });
  return { ok: true };
}));

app.get('/api/alerts/hits', withReadResources(async (req) => {
  const queryInput = req.query as Record<string, unknown>;
  if (Object.keys(queryInput).some((key) => !['naoVistos', 'page', 'pageSize'].includes(key))) throw new BoundedInputError('Parâmetro de consulta inválido.');
  if (Array.isArray(queryInput.naoVistos) || (queryInput.naoVistos !== undefined && !['true', 'false'].includes(String(queryInput.naoVistos)))) throw new BoundedInputError('Parâmetro naoVistos inválido.');
  const { naoVistos } = queryInput as { naoVistos?: string };
  const { page, pageSize, offset } = parsePagination(queryInput.page, queryInput.pageSize);
  const ownerId = (await donoDe(req)).userId;
  // Agrupado por LOTE, não por disparo: cinco alertas parecidos apontando para
  // o mesmo carro viravam cinco linhas idênticas na tela.
  //
  // As colunas são as MESMAS da busca de propósito: a tela de alertas desenha
  // o lote com o mesmo componente de card da listagem, e um SELECT reduzido
  // aqui significaria um segundo card, com campos faltando, para manter.
  const base = `
    SELECT l.id, l.source_id, l.lot_url, l.title_raw, l.title_display, l.auctioneer_name, l.brand, l.model, l.year_make, l.year_model,
           l.km, l.doc_type, l.closing_model, l.auction_start_utc, l.auction_end_utc, l.status,
           l.current_bid, l.min_bid, l.appraisal, l.bid_suspect, l.asset_type, l.vehicle_type,
           l.source_category, l.property_type, l.city, l.state, l.photos, l.photo_count,
           COALESCE((l.raw->>'areaPrivativa')::numeric, (l.raw->>'areaTotal')::numeric, (l.raw->>'areaTerreno')::numeric) AS area,
           (l.raw->>'quartos')::int AS rooms,
           CASE WHEN l.appraisal > 0 AND COALESCE(l.current_bid,l.min_bid) > 0
                THEN ROUND((1 - COALESCE(l.current_bid,l.min_bid)/l.appraisal) * 100) ELSE NULL END AS discount_pct,
           bool_and(h.seen) AS seen,
           max(h.created_at) AS hit_em,
           array_agg(DISTINCT a.label ORDER BY a.label) AS labels,
           count(*)::int AS alertas
      FROM alert_hits h
      JOIN alerts a ON a.id = h.alert_id
      JOIN lots l ON l.id = h.lot_id
      WHERE a.owner_id = $1 ${naoVistos === 'true' ? 'AND NOT h.seen' : ''}
       -- Lote encerrado sai da aba: avisar sobre leilão que já passou é ruído.
       -- Filtra na LEITURA e não apaga o hit, porque lote reabre na 2ª praça
       -- com o mesmo id, e aí ele volta a aparecer sozinho.
       AND l.status NOT IN ('encerrado','vendido')
       -- VENCIDO usa nome de coluna cru: nem alerts nem alert_hits tem
       -- closing_model/auction_*, entao nao ha ambiguidade e prefixar seria
       -- uma segunda copia da regra para divergir. (Sem crase: isto esta
       -- dentro de um template literal e a crase fecharia a string.)
       AND NOT ${VENCIDO}
      GROUP BY l.id`;
  const [{ total }] = await query<{ total: number }>(`SELECT count(*)::int AS total FROM (${base}) grouped`, [ownerId]);
  const rows = await query(`${base} ORDER BY max(h.created_at) DESC, l.id DESC LIMIT $2 OFFSET $3`, [ownerId, pageSize + 1, offset]);
  const pageRows = paginateRows(rows, page, pageSize);
  const lots = pageRows.items.map(toPublicHit);
  return { ...pageRows, items: await accountContext.decorateLots(ownerId, lots), total };
}));

app.post('/api/alerts/hits/seen', withReadResources(async (req) => {
  await query(
    `UPDATE alert_hits SET seen = TRUE
      WHERE NOT seen AND alert_id IN (SELECT id FROM alerts WHERE owner_id = $1)`,
    [(await donoDe(req)).userId],
  );
  return { ok: true };
}));

/* ---------------- favoritos ---------------- */

app.get('/api/favorites', withReadResources(async (req) => {
  const { page, pageSize, offset } = parsePagination((req.query as any)?.page, (req.query as any)?.pageSize);
  const ownerId = (await donoDe(req)).userId;
  // Mesma lista de colunas do card de alertas: um SELECT reduzido aqui
  // significaria um segundo card, com campos faltando, para manter.
  const base = `
    SELECT l.id, l.source_id, l.lot_url, l.title_raw, l.title_display, l.auctioneer_name, l.brand, l.model, l.year_make, l.year_model,
           l.km, l.doc_type, l.closing_model, l.auction_start_utc, l.auction_end_utc, l.status,
           l.current_bid, l.min_bid, l.appraisal, l.bid_suspect, l.asset_type, l.vehicle_type,
           l.source_category, l.property_type, l.city, l.state, l.photos, l.photo_count,
           COALESCE((l.raw->>'areaPrivativa')::numeric, (l.raw->>'areaTotal')::numeric, (l.raw->>'areaTerreno')::numeric) AS area,
           (l.raw->>'quartos')::int AS rooms,
           CASE WHEN l.appraisal > 0 AND COALESCE(l.current_bid,l.min_bid) > 0
                THEN ROUND((1 - COALESCE(l.current_bid,l.min_bid)/l.appraisal) * 100) ELSE NULL END AS discount_pct,
           f.created_at AS favorited_em
      FROM favorites f
      JOIN lots l ON l.id = f.lot_id
      WHERE f.owner_id = $1
       -- Mesmo filtro do /api/alerts/hits: lote encerrado some da lista sem
       -- apagar a linha de favoritos, porque reabre com o mesmo id na 2ª praça.
       AND l.status NOT IN ('encerrado','vendido')
        AND NOT ${VENCIDO}`;
  const [{ total }] = await query<{ total: number }>(`SELECT count(*)::int AS total FROM favorites f JOIN lots l ON l.id = f.lot_id WHERE f.owner_id = $1 AND ${VISIBLE_FAVORITE_PREDICATE}`, [ownerId]);
  const rows = await query(`${base} ORDER BY f.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`, [ownerId, pageSize + 1, offset]);
  const pageRows = paginateRows(rows, page, pageSize);
  return { ...pageRows, items: pageRows.items.map((row) => ({ ...toPublicFavorite(row), favorited: true })), total };
}));

app.post('/api/favorites', withReadResources(async (req, reply) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('lotId' in body)) return reply.code(400).send({ erro: 'corpo inválido' });
  const lotId = safePositiveId((body as any).lotId, { allowString: false });
  if (lotId === null) return reply.code(400).send({ erro: 'lotId inválido' });
  const eu = await donoDe(req);
  await query(
    'INSERT INTO favorites (owner_id, lot_id) VALUES ($1,$2) ON CONFLICT (owner_id, lot_id) DO NOTHING',
    [eu.userId, lotId],
  );
  return { ok: true };
}));

app.delete('/api/favorites/:lotId', withReadResources(async (req, reply) => {
  const { lotId } = req.params as { lotId: string };
  const id = safePositiveId(lotId);
  if (id === null) return reply.code(400).send({ erro: 'lotId inválido' });
  await query('DELETE FROM favorites WHERE owner_id = $1 AND lot_id = $2', [(await donoDe(req)).userId, id]);
  return { ok: true };
}));

/* ---------------- push ---------------- */

app.get('/api/push/key', async () => ({ publicKey: env.VAPID_PUBLIC ?? null }));

/**
 * Download da autoridade certificadora local.
 * O Chrome recusa registrar service worker sobre certificado não confiável —
 * mesmo com o usuário aceitando o aviso da página — então push no celular só
 * funciona depois de instalar esta CA no aparelho.
 */
app.get('/ca.crt', async (_req, reply) => {
  const arq = join(certDir, 'ca.crt');
  if (!existsSync(arq)) return reply.code(404).send({ erro: 'CA não gerada' });
  return reply
    .header('content-type', 'application/x-x509-ca-cert')
    .header('content-disposition', 'attachment; filename="radar-leiloes-ca.crt"')
    .send(readFileSync(arq));
});

app.post('/api/push/subscribe', withReadResources(async (req, reply) => {
  const b = req.body as any;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['endpoint', 'keys'].includes(k))
    || typeof b.endpoint !== 'string' || b.endpoint.length > 4096 || !b.keys || typeof b.keys !== 'object' || Array.isArray(b.keys)
    || Object.keys(b.keys).some((k) => !['p256dh', 'auth'].includes(k))
    || typeof b.keys.p256dh !== 'string' || b.keys.p256dh.length > 512 || !/^[A-Za-z0-9_+\/-]+=*$/.test(b.keys.p256dh)
    || typeof b.keys.auth !== 'string' || b.keys.auth.length > 512 || !/^[A-Za-z0-9_+\/-]+=*$/.test(b.keys.auth)) {
    return reply.code(400).send({ erro: 'inscrição inválida' });
  }
  let endpoint: URL;
  try { endpoint = new URL(b.endpoint); } catch { return reply.code(400).send({ erro: 'inscrição inválida' }); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return reply.code(400).send({ erro: 'inscrição inválida' });
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, owner_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0,
                                          owner_id=EXCLUDED.owner_id`,
    [endpoint.toString(), b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200), (await donoDe(req)).userId],
  );
  return { ok: true };
}));

/**
 * Proxy de imagem. As fotos do Kuss respondem 200 no curl mas o navegador
 * as recusa com ERR_BLOCKED_BY_ORB, deixando 243 lotes (16% do índice) sem
 * imagem. Servir pela própria origem resolve. Só hosts das fontes conhecidas.
 */
const IMG_HOSTS = new Set([
  'www.claudiokussleiloes.com.br',
  'claudiokussleiloes.com.br',
  'ms.sbwebservices.net',
  'static.s4bdigital.net',
  'brimages.copart.com.br',
  'leilo.cdndp.com.br',
  'cdn3.freitasleiloeiro.com.br',
  's3-sa-east-1.amazonaws.com',
  'www.freitasleiloeiro.com.br',
  'www.leilaoeletronico.com.br',
  'leilaoeletronico.com.br',
  'www.casadeleiloes.com.br',
  'casadeleiloes.com.br',
  'rochaleiloes.com.br',
  // Destino de redirect: o static.suporteleiloes.com.br é CNAME do CDN do
  // Lidér e responde 301 para cá. Entra na lista porque o proxy precisa poder
  // saltar para ele.
  'static.liderleiloes.com.br',
]);

/**
 * Vários sites respondem 301 do apex para o www (vialeiloes, tableau, suporte),
 * e o apex em si às vezes nem conecta. `www.` é a mesma origem, não um host
 * novo: aceitar o par não abre a allowlist.
 */
function hostPermitido(host: string): boolean {
  if (IMG_HOSTS.has(host)) return true;
  return host.startsWith('www.') && IMG_HOSTS.has(host.slice(4));
}

/**
 * Buckets com hotlink protection respondem 403 quando o referer não é o site que
 * publica a foto. A chave é o host do bucket; o valor é o referer que o site manda.
 */
const IMG_REFERER = new Map<string, string>([
  ['s3-sa-east-1.amazonaws.com', 'https://www.valland.com.br/'],
]);

const hostImageService = createImageService({
  safeHostChecker: (url) => url.protocol === 'https:' && hostPermitido(url.host),
  refererForHost: (host) => IMG_REFERER.get(host) ?? `https://${host}/`,
  dispatcherForHost: (host) => dependencies.runtime.hostsTlsIncomplete.has(host) ? insecureSemRedirect() : undefined,
  tryAcquireResource,
  tryAcquireImageJob,
  acquireDegradedWork: () => antibot.acquireDegradedWork(),
});
imageService = hostImageService;

/**
 * A lista de hosts de imagem é DERIVADA dos dados, não escrita à mão.
 *
 * Manter à mão já falhou duas vezes: conector novo trazia host novo, ninguém
 * lembrava de somá-lo, e todos os lotes daquela fonte viravam nopic sem erro
 * nenhum na tela. Aqui os hosts vêm das fotos que os nossos próprios conectores
 * gravaram — continua sendo allowlist (o proxy não busca host arbitrário), mas
 * acompanha as fontes sozinha.
 */
async function carregarHostsDeFoto() {
  try {
    const rows = await dependencies.data.query<{ host: string; n: number }>(`
      SELECT split_part(split_part(p, '://', 2), '/', 1) AS host, count(*)::int AS n
      FROM lots, LATERAL jsonb_array_elements_text(photos) AS p
      WHERE p LIKE 'https://%'
      GROUP BY 1 HAVING count(*) > 0`);
    let novos = 0;
    for (const r of rows) {
      if (!r.host || IMG_HOSTS.has(r.host)) continue;
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.host)) continue;
      IMG_HOSTS.add(r.host);
      novos++;
    }
    console.log(`[img] ${IMG_HOSTS.size} hosts permitidos (${novos} vindos dos lotes)`);
  } catch {
    /* banco ainda vazio no primeiro boot */
  }
}

const NOPIC = readFileSync(join(here, 'web', 'nopic.svg'), 'utf8');

/**
 * Falha aqui NÃO pode virar JSON: a tag <img> não renderiza JSON e o cartão
 * fica com um retângulo preto mudo. Qualquer erro devolve o nopic com 200,
 * cacheado por pouco tempo para a foto voltar assim que a origem se recuperar.
 */
function sendNopic(reply: any, motivo: string) {
  return reply
    .code(200)
    .header('content-type', 'image/svg+xml; charset=utf-8')
    .header('cache-control', 'public, max-age=300')
    .header('x-nopic-motivo', motivo)
    .send(NOPIC);
}

/**
 * Reconhece imagem pelos magic bytes, paracuando a origem não manda content-type
 * (ou manda um genérico). Só raster e só o que o sharp decodifica — SVG fica de
 * fora de propósito, pelo mesmo motivo do filtro acima.
 */
function tipoPorMagicBytes(b: Buffer): string {
  if (b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'; // JPEG/JFIF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; // PNG
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand === 'mif1') return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
  }
  return '';
}

/**
 * Cache em memória do que já foi buscado e redimensionado. A origem da Copart
 * manda 168 KB por foto e uma página de 24 cartões pediria ~4 MB do upstream
 * a cada rolagem; o cartão precisa de 600px, não de 1600px.
 */
const imgCache = new Map<string, { type: string; buf: Buffer; at: number }>();
const IMG_CACHE_MAX = 300;
const IMG_TTL_MS = 30 * 60 * 1000;

function cacheGet(key: string) {
  const hit = imgCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IMG_TTL_MS) {
    imgCache.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key: string, type: string, buf: Buffer) {
  if (imgCache.size >= IMG_CACHE_MAX) {
    const oldest = [...imgCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) imgCache.delete(oldest[0]);
  }
  imgCache.set(key, { type, buf, at: Date.now() });
}

app.get('/api/img', async (req, reply) => {
  const query = req.query as Record<string, unknown>;
  if (Array.isArray(query.u) || Array.isArray(query.w) || (query.u !== undefined && typeof query.u !== 'string')
    || (query.w !== undefined && typeof query.w !== 'string')) {
    return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_image_request' });
  }
  const u = query.u as string | undefined;
  const w = query.w as string | undefined;
  if (u && u.length > 4096) return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_image_request' });
  if (w !== undefined && !/^\d+$/.test(w)) return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_image_request' });
  const controller = new AbortController();
  const onAborted = () => controller.abort();
  const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
  req.raw.once('aborted', onAborted);
  reply.raw.once('close', onClose);
  try {
    const outcome = await hostImageService.get(u, w === undefined ? null : Number(w), {
      signal: controller.signal,
      checkMiss: async () => {
        const decision = await antibot.check('imageMiss', { type: 'ip', value: ipDoCliente(req) });
        return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
      },
    });
    if (outcome.kind === 'image') {
      return reply.header('content-type', outcome.contentType).header('cache-control', 'public, max-age=86400')
        .header('x-cache', outcome.cache).send(outcome.buffer);
    }
    if (outcome.kind === 'quota') {
      return reply.code(429).header('Retry-After', String(outcome.retryAfterSeconds)).header('Cache-Control', 'no-store')
        .send({ error: 'rate_limited', retryAfterSeconds: outcome.retryAfterSeconds });
    }
    if (outcome.kind === 'overload') {
      return reply.code(503).header('Retry-After', '1').header('Cache-Control', 'no-store')
        .send({ error: 'overloaded', retryAfterSeconds: 1 });
    }
    if (outcome.kind === 'source-failure') return reply.code(503).header('Cache-Control', 'no-store').send();
    return sendNopic(reply, outcome.reason);
  } finally {
    req.raw.off('aborted', onAborted);
    reply.raw.off('close', onClose);
  }
});

app.get('/api/sources', async (req, reply) => {
  if (exigeAdmin(req, reply)) return;
  const rows = await query(`
    SELECT s.*, COUNT(l.id)::int AS lots, MAX(l.collected_at) AS ultima_coleta
    FROM sources s LEFT JOIN lots l ON l.source_id = s.id
    GROUP BY s.id ORDER BY s.tier, s.name`);
  return rows;
});

registerBrandsRoute(app, (sql) => query<{ brand: string; count: number }>(sql), withReadResources, BRAND_LIST);

/** Espelha como a consulta foi interpretada — usado para depurar a busca. */
app.get('/api/explain', withReadResources(async (req) => {
  const parsed = parseSearchInput(req.query);
  return parseQuery(parsed.q ?? '');
}));

app.post('/api/collect', async (req, reply) => {
  if (exigeAdmin(req, reply)) return;
  if (!collectQueue) throw new Error('Fila de coleta ainda não foi inicializada.');
  const body = (req.body ?? {}) as { sourceId?: string; limit?: number };
  const known = dependencies.jobs.connectors.map((c) => c.def.id);
  // Fonte inexistente respondia 200 e não deixava rastro em collection_runs:
  // um typo de sourceId ficava invisível na tela de cobertura.
  if (body.sourceId && !known.includes(body.sourceId)) {
    return reply.code(400).send({ erro: `fonte desconhecida: ${body.sourceId}`, fontesValidas: known });
  }
  const targets = body.sourceId ? [body.sourceId] : known;
  const jobs = [];
  for (const sourceId of targets) {
    const job = await collectQueue.add('collect:manual', { sourceId, limit: body.limit ?? 300 });
    jobs.push({ sourceId, jobId: job.id });
  }
  return { enfileirado: jobs };
});

// WebSocket: repassa ao navegador o que o worker publica no Redis.
/**
 * O papel fica junto do socket porque o filtro tem de ser no ENVIO. Filtrar só
 * no cliente deixaria o dado de coleta trafegar até o navegador de quem não
 * pode ver — basta abrir o DevTools na aba de rede para ler.
 */
const clients = new Map<any, { papel: Papel; userId: number }>();
const hostSubscriber = dependencies.runtime.makeRedis();
subscriber = hostSubscriber;
hostSubscriber.on('message', (_channel: string, message: string) => {
  let dados: any;
  try {
    dados = JSON.parse(message);
  } catch {
    /* mensagem malformada segue o caminho comum */
  }

  // Alerta é de UM dono: o broadcast mandava os disparos (com ownerId e e-mail)
  // para todos os sockets. Entrega só ao dono e sem e-mail nem ownerId.
  if (dados?.type === 'alertas') {
    const limpos = (dados.disparos ?? []).map((d: any) => ({ ...d, email: undefined, ownerId: undefined }));
    for (const [socket, info] of clients) {
      const meus = dependencies.oidc.oidcLigado() ? limpos.filter((_: any, i: number) => dados.disparos[i].ownerId === info.userId) : limpos;
      if (!meus.length) continue;
      if (!hostWsProtection.safeSend(socket, JSON.stringify({ type: 'alertas', disparos: meus.map((d: any) => ({
        alertId: d.alertId, label: d.label, lotId: d.lotId, title: d.title,
        lotUrl: d.lotUrl, bid: d.bid, source: d.source,
      })) }))) clients.delete(socket);
    }
    return;
  }

  // Telemetria de coleta e de encerramento é de administrador; lance vai para
  // todos. "37 lotes encerrados" não é acionável para quem só busca.
  const soAdmin = ['collect', 'encerrados'].includes(dados?.type);
  for (const [socket, info] of clients) {
    if (soAdmin && info.papel !== 'admin') continue;
    if (!hostWsProtection.safeSend(socket, message)) clients.delete(socket);
  }
});

app.get('/ws', {
  websocket: true,
  preHandler: async (req, reply) => admitWsUpgrade(req as any, reply, {
    protection: hostWsProtection,
    checkAccount: (id) => antibot.check('wsAccount', { type: 'account', id }),
    sendUnauthenticated,
    sendRateLimit,
  }),
}, (socket, req) => {
  // O hook já validou o cookie antes do upgrade; guardamos papel e dono para
  // o filtro de alerta por usuário no envio.
    if (!attachWsUpgrade(req as any, socket, hostWsProtection)) return;
  clients.set(socket, { papel: papelDe(req), userId: Number((req as any).eu?.userId) || 0 });
    hostWsProtection.safeSend(socket, JSON.stringify({ type: 'hello', ts: Date.now() }));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});


let initialization: Promise<void> | undefined;
const initializeResources = () => initialization ??= (async () => {
  await dependencies.runtime.initialize();
  collectQueueConnection = dependencies.runtime.makeRedis();
  collectQueue = dependencies.jobs.createCollectQueue(collectQueueConnection);
  const tryConnect = async (client: { status?: string; connect?: () => Promise<unknown> } | undefined) => {
    if (client?.status === 'wait') {
      try { await client.connect?.(); } catch { /* keep the existing degraded Redis behavior */ }
    }
  };
  await Promise.all([tryConnect(loginRedis), tryConnect(redisCadastro), tryConnect(antibotRedis), tryConnect(wsRedis)]);
  await hostSubscriber.subscribe(dependencies.runtime.CHANNEL_UPDATES);
  await dependencies.data.ensureSources();
  await carregarHostsDeFoto();
})().catch(async (error) => {
  try { await app.close(); } catch (closeError) { throw new AggregateError([error, closeError], 'Host startup and cleanup both failed.'); }
  throw error;
});
return { app, initializeResources };
}
