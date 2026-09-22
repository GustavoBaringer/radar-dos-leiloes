import Fastify from 'fastify';
import { request as undiciRequest } from 'undici';
import sharp from 'sharp';
import { insecureDispatcher, HOSTS_TLS_INCOMPLETO } from './connectors/http.js';
import fastifyStatic from '@fastify/static';
import { pathToFileURL } from 'node:url';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searchLots, searchLotsMapa, getLot, getStats, ensureSources } from './core/repo.js';
import { VENCIDO } from './core/encerramento.js';
import { contarCasaveis, avaliarAlertas } from './core/alerts.js';
import { authLigada, papelDasCredenciais, criarToken, lerToken, precisaRenovar, JANELAS, COOKIE, type Papel } from './core/auth.js';
import { oidcLigado, iniciarLogin, concluirLogin, urlDeLogout, COOKIE_OIDC, COOKIE_PKCE } from './core/oidc.js';
import { garantirUsuario, identidadePorSub, usuarioDoPortao, ANONIMO, type Identidade } from './core/identidade.js';
import { query } from './core/db.js';
import { BRAND_LIST, parseQuery } from './core/normalize.js';
import { connectors } from './connectors/index.js';
import { collectQueue, makeRedis, CHANNEL_UPDATES } from './queue/queues.js';

/**
 * HTTPS opcional, com certificado próprio.
 * O Chrome do Android força https:// em IP de rede local mesmo com o
 * "sempre usar conexões seguras" desligado (o upgrade fica em cache), e aí
 * o servidor HTTP responde lixo e o navegador mostra ERR_SSL_PROTOCOL_ERROR.
 * Servir TLS resolve de vez: o aviso de certificado se aceita uma vez.
 */
const certDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs');
const temCert = existsSync(join(certDir, 'local.crt')) && existsSync(join(certDir, 'local.key'));

const app = Fastify({ logger: false });
// O formulário de login envia urlencoded; sem isto req.body vem undefined.
await app.register(formbody);

/**
 * Portão de senha. Só liga quando APP_SENHA existe no ambiente, então o uso
 * local continua sem atrito. O service worker do push precisa passar livre:
 * o navegador o busca sem cookie de sessão e um 302 ali quebraria o push.
 */
const LIVRES = new Set(['/login', '/api/login', '/auth/login', '/auth/callback', '/auth/logout', '/sw.js', '/nopic.svg', '/nopic-imovel.svg', '/ca.crt']);

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
  // O proxy de imagem é o que desenha as fotos da vitrine. Sem ele a landing
  // pública abre com oito placeholders.
  '/api/img',
  '/landing.css',
  '/landing.js',
  '/cartao.js',
  '/cartao.css',
  '/slug.js',
  '/nopic.svg',
  '/nopic-imovel.svg',
]);
/**
 * A PÁGINA do lote é pública; a API continua fechada.
 *
 * Isso é possível porque o SSR lê do Postgres direto (`getLot`), sem passar por
 * `/api/lot/:id` — abrir a página não abre endpoint nenhum. Sem isso, o robô do
 * WhatsApp levava 302 para /login e o preview do link mostrava "Entrar · Radar
 * de Leilões" em vez do lote.
 *
 * O que o visitante anônimo vê é decidido no render: o lote e o link para o
 * leiloeiro, não a busca nem as facetas.
 */
const ehPublica = (caminho: string) =>
  PUBLICAS.has(caminho) || caminho.startsWith('/lote/') || caminho.startsWith('/assets/');

const PAGINA_LOGIN = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Radar de Leilões</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;
     background:radial-gradient(1200px 600px at 50% -10%,#18202b,#0d1117 60%);color:#e7edf5;
     font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{width:100%;max-width:360px;background:#141a22;border:1px solid #27313d;border-radius:16px;
     padding:30px 26px;box-shadow:0 18px 40px rgba(0,0,0,.45)}
.marca{display:flex;align-items:center;gap:9px;margin-bottom:22px}
.dot{width:11px;height:11px;border-radius:3px;background:#6c7cff}
.marca b{font-size:17px;letter-spacing:-.2px}
label{display:block;font-size:12px;color:#8b98a8;margin:14px 0 6px;letter-spacing:.02em}
input{width:100%;background:#0d1117;border:1px solid #27313d;border-radius:10px;
      padding:12px 13px;color:#e7edf5;font-size:16px}
input:focus{outline:2px solid #2f6feb;outline-offset:1px;border-color:#2f6feb}
button{width:100%;margin-top:20px;background:#2f6feb;border:0;border-radius:10px;padding:13px;
       color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#3d7bf5}
.erro{background:#3a1b1b;border:1px solid #7a3030;color:#ffb4b4;border-radius:9px;
      padding:10px 12px;font-size:13px;margin-bottom:6px}
.rodape{margin-top:18px;font-size:11.5px;color:#5f6b7a;text-align:center}
.ou{display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#5f6b7a;font-size:11px}
.ou::before,.ou::after{content:"";flex:1;height:1px;background:#27313d}
.oidc{display:block;text-align:center;text-decoration:none;background:transparent;border:1px solid #27313d;
      border-radius:10px;padding:12px;color:#e7edf5;font-size:14px;font-weight:600}
.oidc:hover{border-color:#2f6feb;background:#121a24}
</style></head><body>
<form method="POST" action="/api/login">
  <div class="marca"><span class="dot"></span><b>Radar de Leilões</b></div>
  <input type="hidden" name="de" value="__DE__">
  __ERRO__
  <label for="usuario">Usuário</label>
  <input id="usuario" name="usuario" autocomplete="username" autocapitalize="none" autofocus required>
  <label for="senha">Senha</label>
  <input id="senha" name="senha" type="password" autocomplete="current-password" required>
  <button type="submit">Entrar</button>
  __OIDC__
  <p class="rodape">Acesso restrito</p>
</form></body></html>`;

if (authLigada()) {
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
    if (ehPublica(caminho) && semSessao && (req.method === 'GET' || caminho === '/api/espera')) {
      (req as any).papel = 'comum';
      // userId 0: nenhuma linha de users tem esse id, então consulta filtrada
      // por dono devolve vazio em vez de devolver os alertas do administrador.
      (req as any).eu = ANONIMO;
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
      const eu = sessao.sub ? await identidadePorSub(sessao.sub) : await usuarioDoPortao(sessao.papel);
      // Sessão assinada apontando para usuário que não existe mais (conta
      // apagada no provedor): melhor mandar para o login do que seguir sem dono.
      if (!eu) return reply.code(302).header('location', '/login').send();
      (req as any).eu = eu;
      (req as any).papel = eu.papel;
      return;
    }
    // Cookie presente mas inválido (expirado, adulterado) numa rota pública:
    // segue como anônimo em vez de mandar para o login. Quem compartilhou o
    // link não tem culpa da sessão velha de quem o abriu.
    if (ehPublica(caminho) && req.method === 'GET') {
      (req as any).papel = 'comum';
      (req as any).eu = ANONIMO;
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
      caminho === '/' || APP_ROTAS.includes(caminho) || caminho.startsWith('/lote/');
    return permitido ? v : DESTINO_PADRAO;
  }
  const escapaAtributo = (v: string) =>
    v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const telaLogin = (de: unknown, erro = '') => {
    const destino = destinoSeguro(de);
    // O bloco do provedor só existe quando o OIDC está configurado: um botão
    // que leva a 404 é pior do que botão nenhum.
    const bloco = oidcLigado()
      ? `<div class="ou">ou</div><a class="oidc" href="/auth/login?de=${encodeURIComponent(destino)}">Entrar com conta Radar</a>`
      : '';
    return PAGINA_LOGIN.replace('__DE__', escapaAtributo(destino))
      .replace('__ERRO__', erro)
      .replace('__OIDC__', bloco);
  };

  app.get('/login', async (req, reply) =>
    reply.type('text/html; charset=utf-8').send(telaLogin((req.query as any)?.de)),
  );

  /**
   * Login por provedor OIDC (Keycloak).
   *
   * O `redirect_uri` é derivado do host da requisição, não de variável fixa: a
   * POC é acessada por localhost E pelo túnel, e um valor fixo quebraria um dos
   * dois. O provedor só aceita URIs que estão na allowlist do client, então
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
    if (!oidcLigado()) return reply.code(404).send({ erro: 'OIDC desligado' });
    try {
      const { url, cookie } = await iniciarLogin(uriDeCallback(req), destinoSeguro((req.query as any)?.de));
      return reply
        // O cookie do PKCE vive minutos e é SameSite=Lax porque o provedor
        // devolve a pessoa por navegação de topo — com Strict ele não voltaria.
        .header('set-cookie', `${COOKIE_PKCE}=${cookie}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`)
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
    if (!oidcLigado()) return reply.code(404).send({ erro: 'OIDC desligado' });
    const q = (req.query as any) ?? {};
    const pkce = String(req.headers.cookie ?? '')
      .split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE_PKCE)?.[1];
    // O provedor devolve erro na própria query quando o usuário cancela.
    if (q.error) {
      return reply.code(400).type('text/html; charset=utf-8').send(
        telaLogin('', `<div class="erro">Login cancelado no provedor (${String(q.error).slice(0, 40)}).</div>`),
      );
    }
    try {
      const r = await concluirLogin({ code: String(q.code ?? ''), state: String(q.state ?? ''), cookiePkce: pkce, redirectUri: uriDeCallback(req) });
      const eu = await garantirUsuario({ sub: r.sub, email: r.email, nome: r.nome, papel: r.papel });
      return reply
        .header('set-cookie', [
          cookieDeSessao(req, criarToken(eu.papel, eu.sub)),
          `${COOKIE_PKCE}=; Path=/auth; Max-Age=0`,
          `${COOKIE_OIDC}=1; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
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
    const limpa = [cookieDeSessao(req, '', 0), `${COOKIE_OIDC}=; Path=/; Max-Age=0`];
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
    let destino = '/login';
    if (veioDeOidc && oidcLigado()) {
      try {
        destino = (await urlDeLogout(`${proto}://${req.headers.host}/login`)) ?? '/login';
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
   * atraso nenhum. Com uma senha só protegendo o índice inteiro e a POC exposta
   * por túnel público, isso é o furo mais explorável que existia.
   *
   * O contador vive no Redis, não em memória: o processo reinicia a cada edição
   * de código, e um contador que zera no restart não é freio.
   */
  // Conexão própria: a outra do servidor está em modo subscribe, e no ioredis
  // uma conexão inscrita em canal não aceita mais comandos comuns.
  const redis = makeRedis();
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
  const ipDe = (req: any) =>
    String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.ip ?? '')
      .split(',')[0]
      .trim() || 'desconhecido';

  app.post('/api/login', async (req, reply) => {
    const corpo = (req.body ?? {}) as any;
    const ip = ipDe(req);
    if ((await tentativasDe(ip)) >= TETO) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(telaLogin(corpo.de, '<div class="erro">Muitas tentativas. Aguarde 15 minutos.</div>'));
    }
    const papel = papelDasCredenciais(corpo.usuario ?? '', corpo.senha ?? '');
    if (!papel) {
      await registraFalha(ip);
      // Mensagem única de propósito: dizer qual campo errou entrega ao atacante
      // a confirmação de que o usuário existe.
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(telaLogin(corpo.de, '<div class="erro">Usuário ou senha incorretos.</div>'));
    }
    // Acerto zera o contador: senão quem errou 7 vezes e acertou continuaria
    // a um erro do bloqueio pelos 15 minutos seguintes.
    try {
      await redis.del(`login:falha:${ip}`);
    } catch {
      /* sem Redis, sem contador para zerar */
    }
    return reply
      .header('set-cookie', cookieDeSessao(req, criarToken(papel, null)))
      .code(302)
      // `/` é a landing de venda e é idêntica antes e depois de entrar: mandar
      // para lá dava a impressão de que o login não tinha funcionado.
      .header('location', destinoSeguro(corpo.de))
      .send();
  });
}
const here = dirname(fileURLToPath(import.meta.url));

await app.register(websocket);
await app.register(fastifyStatic, { root: join(here, 'web'), prefix: '/', index: false });

/**
 * O app de busca (React/Vite) vive em app-busca/ e é servido daqui.
 *
 * `decorateReply: false` porque o primeiro registro de fastify-static já
 * decorou o reply com sendFile; um segundo registro sem isso derruba o boot
 * com "reply.sendFile already exists".
 */
const APP_DIST = join(here, '..', 'app-busca', 'dist');
const APP_CLIENTE = join(APP_DIST, 'client');
const temAppNovo = existsSync(join(APP_CLIENTE, 'index.html'));
if (temAppNovo) {
  await app.register(fastifyStatic, {
    root: join(APP_CLIENTE, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    // Nome com hash do conteúdo: mudou o arquivo, mudou a URL. Pode cachear
    // forte, e é o que tira a Cloudflare do caminho crítico do deploy.
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
const APP_ROTAS = ['/busca', '/alertas', '/cobertura'];

/**
 * A URL do estático carrega a data de modificação. `cache-control: max-age=0`
 * com ETag não basta: quem acessa pelo túnel passa pela borda da Cloudflare,
 * que cacheia .js e .css por conta própria e serviu versão velha por horas.
 * Mudando a URL, nenhuma camada de cache tem o que reaproveitar.
 */
const ESTATICOS = ['slug.js', 'cartao.js', 'landing.js', 'landing.css', 'cartao.css'];
/** Origem pública do site, usada em canonical, Open Graph, JSON-LD e sitemap. */
const SITE = (process.env.SITE_URL ?? 'http://localhost:4500').replace(/\/$/, '');

/**
 * Origem absoluta desta requisição.
 *
 * `SITE_URL` não está definido em desenvolvimento, e o padrão `localhost:4500`
 * ia parar dentro do og:image — que o robô do WhatsApp não alcança, então o
 * preview vinha sem foto mesmo com a meta presente. O host da requisição é o
 * endereço por onde o visitante REALMENTE chegou (o domínio do túnel, o
 * domínio de produção), e é ele que serve para montar URL absoluta.
 *
 * `SITE_URL` continua vencendo quando configurado: em produção a origem
 * canônica é decisão nossa, não do cabeçalho que o cliente mandou.
 */
function origemDe(req: any): string {
  if (process.env.SITE_URL) return SITE;
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
app.get('/', enviaPagina('landing.html'));
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
app.get('/lote/:slug', async (req, reply) => {
  if (!temAppNovo) {
    return reply.code(503).type('text/plain; charset=utf-8').send('app-busca não construído');
  }
  const html = cascaDoApp();
  const id = Number(/-(\d+)$/.exec(String((req.params as any).slug ?? ''))?.[1]);
  // O SSR renderiza a gaveta inteira, então precisa do MESMO objeto que
  // /api/lot/:id entrega — o SELECT curto de antes só servia para montar meta,
  // e renderizar com menos campos aqui do que o cliente tem faria a hidratação
  // divergir campo a campo.
  const lot = Number.isFinite(id) ? await getLot(id) : null;
  if (!lot) return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);

  const titulo = lot.title_display || lot.title_raw;
  const local = [lot.city, lot.state].filter(Boolean).join('/');
  const lance = dinheiroBR(lot.current_bid ?? lot.min_bid);
  const bem = lot.asset_type === 'imovel' ? 'Imóvel' : 'Veículo';
  const descricao = [
    `${bem} em leilão: ${titulo}.`,
    local ? `Local: ${local}.` : '',
    lance ? `Lance ${lot.current_bid != null ? 'atual' : 'mínimo'}: ${lance}.` : 'Sem lance publicado.',
    'Prazo e link direto para o site do leiloeiro no Radar de Leilões.',
  ].filter(Boolean).join(' ');
  const origem = origemDe(req);
  const foto = lot.photos?.[0] ? `${origem}/api/img?u=${encodeURIComponent(lot.photos[0])}&w=1200` : '';

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: titulo,
    description: descricao,
    ...(foto ? { image: foto } : {}),
    ...(lot.brand ? { brand: { '@type': 'Brand', name: lot.brand } } : {}),
    offers: {
      '@type': 'Offer',
      priceCurrency: 'BRL',
      // O lance corrente é o preço que existe hoje; a avaliação não é preço de venda.
      ...(lot.current_bid ?? lot.min_bid ? { price: String(lot.current_bid ?? lot.min_bid) } : {}),
      availability: 'https://schema.org/InStock',
      url: `${origem}/lote/${(req.params as any).slug}`,
      ...(lot.auction_end_utc ? { priceValidUntil: new Date(lot.auction_end_utc).toISOString().slice(0, 10) } : {}),
      ...(lot.auctioneer_name ? { seller: { '@type': 'Organization', name: lot.auctioneer_name } } : {}),
    },
  };

  const cabeca = [
    `<title>${esc(titulo)}${local ? ` em ${esc(local)}` : ''} — leilão | Radar de Leilões</title>`,
    `<meta name="description" content="${esc(descricao)}">`,
    `<link rel="canonical" href="${origem}/lote/${esc((req.params as any).slug)}">`,
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
  const publico = (req as any).eu === ANONIMO || (req as any).papel == null;
  const render = temAppNovo ? await carregarRender() : null;
  if (render) {
    try {
      const marcado = render(lot, publico);
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
      const estado = JSON.stringify(lot).replaceAll('<', '\\u003c');
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

  return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(corpo);
});

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

app.get('/api/home', async () => {
  const [recentes, leiloeiros] = await Promise.all([
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
  const [[{ fontes, total, totalLeiloeiros }], ufs] = await Promise.all([
    query<{ fontes: number; total: number; totalLeiloeiros: number }>(
      `SELECT count(DISTINCT source_id)::int AS fontes, count(*)::int AS total,
              count(DISTINCT auctioneer_name) FILTER (WHERE auctioneer_name <> '')::int AS "totalLeiloeiros"
         FROM lots WHERE status IN ('aberto','agendado','sem_data')`,
    ),
    query<{ uf: string; total: number }>(
      `SELECT state AS uf, count(*)::int AS total
         FROM lots WHERE state IS NOT NULL AND status IN ('aberto','agendado','sem_data')
        GROUP BY 1 ORDER BY 2 DESC`,
    ),
  ]);
  return { recentes, leiloeiros, fontes, total, totalLeiloeiros, ufs };
});

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

app.get('/api/vitrine', async () => {
  const ABERTOS = `status IN ('aberto','agendado','sem_data')`;
  // As categorias são as do índice de verdade, com a mesma query que o filtro da
  // busca usa — assim o número do cartão e o resultado do clique não divergem.
  const CATEGORIAS = [
    { id: 'veiculos', label: 'Veículos', dica: 'carros, picapes, SUVs, utilitários', icone: 'carro',
      query: 'assetType=veiculo&vehicleType=carro,picape,suv,utilitario',
      onde: `asset_type='veiculo' AND vehicle_type IN ('carro','picape','suv','utilitario')` },
    { id: 'imoveis', label: 'Imóveis', dica: 'casas, apartamentos, terrenos, comerciais', icone: 'casa',
      query: 'assetType=imovel', onde: `asset_type='imovel'` },
    { id: 'motos', label: 'Motos', dica: 'street, scooter, trail, sucata', icone: 'moto',
      query: 'assetType=veiculo&vehicleType=moto', onde: `vehicle_type='moto'` },
    { id: 'maquinas', label: 'Máquinas e agro', dica: 'tratores, escavadeiras, reboques', icone: 'maquina',
      query: 'assetType=veiculo&vehicleType=maquina,reboque', onde: `vehicle_type IN ('maquina','reboque')` },
    { id: 'judiciais', label: 'Judiciais', dica: 'penhora, execução, inventário', icone: 'martelo',
      query: 'docType=judicial', onde: `doc_type='judicial'` },
  ];

  const [agregados, ufs, categorias, leiloeiros, recentes, encerrando, porHora] = await Promise.all([
    query<any>(
      `SELECT count(DISTINCT source_id)::int AS fontes,
              count(*)::int AS total,
              count(DISTINCT auctioneer_name) FILTER (WHERE auctioneer_name <> '')::int AS "totalLeiloeiros",
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
    recentes,
    categorias: CATEGORIAS.map(({ onde: _onde, ...rest }, i) => ({ ...rest, total: c[`c${i}`] ?? 0 })),
    encerrando: encerrando.map((l: any) => ({ ...l, quando: emQuanto(l.auction_end_utc) })),
    porHora: porHora.map((r: any) => r.total),
  };
});

/**
 * Lista de espera. O e-mail é de terceiro, então o registro guarda junto o texto
 * de consentimento que a pessoa leu — sem isso não há como demonstrar a base
 * legal depois, e o dado vira passivo em vez de ativo.
 */
app.post('/api/espera', async (req, reply) => {
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
  // Reenvio do mesmo e-mail não é erro para quem preencheu: a resposta diz que
  // já estava, em vez de devolver 409 e parecer falha.
  return { ok: true, jaEstava: linhas.length === 0 };
});

app.get('/api/home/leiloeiro', async (req, reply) => {
  const nome = String((req.query as any)?.nome ?? '').trim();
  if (!nome) return reply.code(400).send({ erro: 'informe o leiloeiro' });
  return query(
    `SELECT ${COLUNAS_CARTAO}
       FROM lots
      WHERE auctioneer_name = $1 AND status IN ('aberto','agendado')
      ORDER BY (photos IS NOT NULL AND jsonb_array_length(photos) > 0) DESC, first_seen_at DESC
      LIMIT 24`,
    [nome],
  );
});

const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));

app.get('/api/search', async (req) => {
  const q = req.query as Record<string, string>;
  return searchLots({
    q: q.q,
    // Os filtros de lista chegam como 'SP,RJ' da tela de seleção múltipla;
    // o repositório já aceita CSV, array ou valor único.
    uf: q.uf,
    status: q.status,
    sellerType: q.sellerType,
    sourceId: q.sourceId,
    auctioneer: q.auctioneer,
    seller: q.seller,
    assetType: q.assetType,
    vehicleType: q.vehicleType,
    propertyType: q.propertyType,
    city: q.city,
    priceMin: num(q.priceMin),
    priceMax: num(q.priceMax),
    yearMin: num(q.yearMin),
    yearMax: num(q.yearMax),
    place: q.place,
    onlyWithDate: q.onlyWithDate === 'true',
    onlyWithPhoto: q.onlyWithPhoto === 'true',
    includeEnded: q.includeEnded === 'true',
    sort: (q.sort as any) ?? 'ending_soon',
    page: num(q.page) ?? 1,
    pageSize: num(q.pageSize) ?? 24,
  });
});

/**
 * Malha territorial do IBGE, servida daqui porque o desenho do mapa não pode
 * depender de terceiro no caminho crítico. `uf` sempre; `municipio` só quando o
 * usuário aproxima, e são 2,3 MB — nunca no carregamento inicial.
 */
app.get('/api/malha/:tipo', async (req, reply) => {
  const { tipo } = req.params as { tipo: string };
  if (tipo !== 'uf' && tipo !== 'municipio') return reply.code(404).send({ error: 'malha desconhecida' });
  const arq = join(here, '..', 'data', 'geo', `${tipo}.json`);
  if (!existsSync(arq)) return reply.code(404).send({ error: 'malha ausente' });
  return reply.header('cache-control', 'public, max-age=604800, immutable').type('application/json').send(readFileSync(arq));
});

app.get('/api/search/mapa', async (req) => {
  const q = req.query as Record<string, string>;
  return searchLotsMapa({
    q: q.q, uf: q.uf, status: q.status, sellerType: q.sellerType, sourceId: q.sourceId,
    auctioneer: q.auctioneer, seller: q.seller, assetType: q.assetType,
    vehicleType: q.vehicleType, propertyType: q.propertyType, city: q.city,
    priceMin: num(q.priceMin), priceMax: num(q.priceMax),
    yearMin: num(q.yearMin), yearMax: num(q.yearMax),
    onlyWithDate: q.onlyWithDate === 'true', onlyWithPhoto: q.onlyWithPhoto === 'true',
    includeEnded: q.includeEnded === 'true',
  });
});

app.get('/api/lot/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  // Sem isso o Postgres estourava 500 vazando código interno (22P02).
  if (!/^\d+$/.test(id)) return reply.code(400).send({ error: 'id inválido' });
  const lot = await getLot(Number(id));
  if (!lot) return reply.code(404).send({ error: 'lote não encontrado' });
  return lot;
});

/**
 * O dono da requisição. Sem portão de senha o modo local segue aberto e tudo
 * pertence à conta administradora — é o comportamento de sempre no localhost.
 */
const donoDe = async (req: any): Promise<Identidade> =>
  (req.eu as Identidade) ?? (await usuarioDoPortao(authLigada() ? 'comum' : 'admin'));

/** Sem portão de senha, não há papel: o modo local continua aberto como sempre. */
const papelDe = (req: any): Papel => (authLigada() ? ((req.papel as Papel) ?? 'comum') : 'admin');

/** O cliente não decide o próprio papel: ele pergunta, e a resposta vem do cookie assinado. */
app.get('/api/me', async (req) => {
  const eu = await donoDe(req);
  return {
    papel: papelDe(req),
    authLigada: authLigada(),
    oidc: oidcLigado(),
    // `sub` presente = entrou por provedor; ausente = portão de senha.
    conta: { id: eu.userId, email: eu.email, nome: eu.nome, porProvedor: eu.sub != null },
  };
});

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

app.get('/api/stats', async (req, reply) => (exigeAdmin(req, reply) ? undefined : getStats()));

/* ---------------- alertas ---------------- */

app.get('/api/alerts', async (req) => {
  const eu = await donoDe(req);
  return query(
    `SELECT a.*,
            (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id) AS total,
            (SELECT count(*)::int FROM alert_hits h WHERE h.alert_id = a.id AND NOT h.seen) AS nao_vistos
       FROM alerts a WHERE a.owner_id = $1 ORDER BY a.created_at DESC`,
    [eu.userId],
  );
});

app.post('/api/alerts', async (req, reply) => {
  const b = (req.body ?? {}) as any;
  const q = String(b.q ?? '').trim();
  const filters = b.filters ?? {};
  if (!q && !Object.keys(filters).length) {
    return reply.code(400).send({ erro: 'informe um termo de busca ou ao menos um filtro' });
  }
  const canais: string[] = Array.isArray(b.channels) && b.channels.length ? b.channels : ['sino'];
  if (canais.includes('email') && !b.email) {
    return reply.code(400).send({ erro: 'canal e-mail exige um endereço' });
  }
  const [a] = await query<any>(
    `INSERT INTO alerts (label, q, filters, channels, email, owner_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [String(b.label ?? q ?? 'Alerta').slice(0, 80), q || null, JSON.stringify(filters), canais, b.email ?? null, (await donoDe(req)).userId],
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
  const casaveis = await contarCasaveis(a);
  return { ...a, casados_agora: 0, no_indice_agora: casaveis };
});

app.patch('/api/alerts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^\d+$/.test(id)) return reply.code(400).send({ erro: 'id inválido' });
  const b = (req.body ?? {}) as any;
  const canais: string[] = Array.isArray(b.channels) && b.channels.length ? b.channels : ['sino'];
  if (canais.includes('email') && !b.email) {
    return reply.code(400).send({ erro: 'canal e-mail exige um endereço' });
  }
  const [a] = await query<any>(
    `UPDATE alerts SET label = COALESCE($2, label), channels = $3, email = $4 WHERE id = $1 RETURNING *`,
    [Number(id), b.label ? String(b.label).slice(0, 80) : null, canais, b.email ?? null],
  );
  if (!a) return reply.code(404).send({ erro: 'alerta não encontrado' });
  return a;
});

app.delete('/api/alerts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!/^\d+$/.test(id)) return reply.code(400).send({ erro: 'id inválido' });
  // O dono entra no WHERE, não numa checagem antes: com a verificação separada
  // existe a janela entre ler e apagar, e um 404 honesto é melhor que um 403
  // que confirma a existência do alerta de outra pessoa.
  const apagados = await query<{ id: string }>(
    'DELETE FROM alerts WHERE id = $1 AND owner_id = $2 RETURNING id',
    [Number(id), (await donoDe(req)).userId],
  );
  if (!apagados.length) return reply.code(404).send({ erro: 'alerta não encontrado' });
  return { ok: true };
});

app.get('/api/alerts/hits', async (req) => {
  const { naoVistos } = req.query as { naoVistos?: string };
  // Agrupado por LOTE, não por disparo: cinco alertas parecidos apontando para
  // o mesmo carro viravam cinco linhas idênticas na tela.
  //
  // As colunas são as MESMAS da busca de propósito: a tela de alertas desenha
  // o lote com o mesmo componente de card da listagem, e um SELECT reduzido
  // aqui significaria um segundo card, com campos faltando, para manter.
  return query(`
    SELECT l.id, l.source_id, l.lot_url, l.title_raw, l.brand, l.model, l.year_make, l.year_model,
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
     GROUP BY l.id
     ORDER BY max(h.created_at) DESC LIMIT 60`, [(await donoDe(req)).userId]);
});

app.post('/api/alerts/hits/seen', async (req) => {
  await query(
    `UPDATE alert_hits SET seen = TRUE
      WHERE NOT seen AND alert_id IN (SELECT id FROM alerts WHERE owner_id = $1)`,
    [(await donoDe(req)).userId],
  );
  return { ok: true };
});

/* ---------------- favoritos ---------------- */

app.get('/api/favorites', async (req) => {
  // Mesma lista de colunas do card de alertas: um SELECT reduzido aqui
  // significaria um segundo card, com campos faltando, para manter.
  return query(`
    SELECT l.id, l.source_id, l.lot_url, l.title_raw, l.brand, l.model, l.year_make, l.year_model,
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
     ORDER BY f.created_at DESC`, [(await donoDe(req)).userId]);
});

app.post('/api/favorites', async (req, reply) => {
  const { lotId } = (req.body ?? {}) as { lotId?: number };
  if (!Number.isInteger(lotId)) return reply.code(400).send({ erro: 'lotId inválido' });
  const eu = await donoDe(req);
  await query(
    'INSERT INTO favorites (owner_id, lot_id) VALUES ($1,$2) ON CONFLICT (owner_id, lot_id) DO NOTHING',
    [eu.userId, lotId],
  );
  return { ok: true };
});

app.delete('/api/favorites/:lotId', async (req, reply) => {
  const { lotId } = req.params as { lotId: string };
  if (!/^\d+$/.test(lotId)) return reply.code(400).send({ erro: 'lotId inválido' });
  await query('DELETE FROM favorites WHERE owner_id = $1 AND lot_id = $2', [(await donoDe(req)).userId, Number(lotId)]);
  return { ok: true };
});

/* ---------------- push ---------------- */

app.get('/api/push/key', async () => ({ publicKey: process.env.VAPID_PUBLIC ?? null }));

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

app.post('/api/push/subscribe', async (req, reply) => {
  const b = (req.body ?? {}) as any;
  if (!b?.endpoint || !b?.keys?.p256dh || !b?.keys?.auth) {
    return reply.code(400).send({ erro: 'inscrição inválida' });
  }
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, owner_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0,
                                          owner_id=EXCLUDED.owner_id`,
    [b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200), (await donoDe(req)).userId],
  );
  return { ok: true };
});

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
]);

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
    const rows = await query<{ host: string; n: number }>(`
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
  const { u, w } = req.query as { u?: string; w?: string };
  // Math.max(120, ...) nunca devolve 0, então `|| null` jamais disparava e a
  // requisição SEM largura acabava redimensionada para 120px. Só há largura
  // quando o cliente pede uma largura.
  const pedido = Number(w);
  const width = w && Number.isFinite(pedido) && pedido > 0 ? Math.min(1600, Math.max(120, pedido)) : null;
  if (!u) return sendNopic(reply, 'sem-url');
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return sendNopic(reply, 'url-invalida');
  }
  if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.host)) {
    return sendNopic(reply, 'host-nao-permitido');
  }
  const key = `${target.href}|${width ?? 'full'}`;
  const cached = cacheGet(key);
  if (cached) {
    return reply
      .header('content-type', cached.type)
      .header('cache-control', 'public, max-age=86400')
      .header('x-cache', 'hit')
      .send(cached.buf);
  }

  try {
    const res = await undiciRequest(target.href, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        referer: `${target.origin}/`,
      },
      headersTimeout: 15000,
      bodyTimeout: 15000,
      ...(HOSTS_TLS_INCOMPLETO.has(target.host) ? { dispatcher: insecureDispatcher() } : {}),
    });
    const type = String(res.headers['content-type'] ?? '');
    if (res.statusCode !== 200 || !type.startsWith('image/')) {
      res.body.dump();
      return sendNopic(reply, `origem-${res.statusCode}`);
    }
    const original = Buffer.from(await res.body.arrayBuffer());

    let out = original;
    let outType = type;
    if (width) {
      try {
        // withoutEnlargement: foto pequena (o Leilo publica 460px) não é
        // esticada — subir resolução só inventaria borrão e peso.
        out = await sharp(original)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        outType = 'image/webp';
      } catch {
        out = original;
        outType = type;
      }
    }
    cachePut(key, outType, out);
    reply.header('content-type', outType).header('cache-control', 'public, max-age=86400').header('x-cache', 'miss');
    return reply.send(out);
  } catch (err: any) {
    return sendNopic(reply, `erro-rede:${String(err?.code ?? err?.message ?? 'desconhecido').slice(0, 40)}`);
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

app.get('/api/brands', async () => {
  const rows = await query<{ brand: string; count: number }>(
    'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC',
  );
  return { known: BRAND_LIST, present: rows };
});

/** Espelha como a consulta foi interpretada — usado para depurar a busca. */
app.get('/api/explain', async (req) => {
  const { q } = req.query as { q?: string };
  return parseQuery(q ?? '');
});

app.post('/api/collect', async (req, reply) => {
  if (exigeAdmin(req, reply)) return;
  const body = (req.body ?? {}) as { sourceId?: string; limit?: number };
  const known = connectors.map((c) => c.def.id);
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
const clients = new Map<any, Papel>();
const subscriber = makeRedis();
await subscriber.subscribe(CHANNEL_UPDATES);
subscriber.on('message', (_channel, message) => {
  // Telemetria de coleta e de encerramento é de administrador; lance e alerta
  // vão para todos. "37 lotes encerrados" não é acionável para quem só busca.
  let soAdmin = false;
  try {
    soAdmin = ['collect', 'encerrados'].includes(JSON.parse(message)?.type);
  } catch {
    /* mensagem malformada segue o caminho comum */
  }
  for (const [socket, papel] of clients) {
    if (soAdmin && papel !== 'admin') continue;
    try {
      socket.send(message);
    } catch {
      clients.delete(socket);
    }
  }
});

app.get('/ws', { websocket: true }, (socket, req) => {
  // O hook de autenticação já validou o cookie antes do upgrade; aqui só
  // guardamos o papel que ele decodificou.
  clients.set(socket, papelDe(req));
  socket.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

await ensureSources();
await carregarHostsDeFoto();
const port = Number(process.env.PORT ?? 4500);
await app.listen({ port, host: '0.0.0.0' });
console.log(`API e interface em http://localhost:${port}`);

if (temCert) {
  // Terminador TLS puro: aceita HTTPS e repassa para a própria instância HTTP,
  // inclusive o upgrade do WebSocket. Não duplica rota nem lógica.
  const { createServer } = await import('node:https');
  const { request: httpRequest } = await import('node:http');

  const portaTls = port + 1;
  const tls = createServer(
    {
      key: readFileSync(join(certDir, 'local.key')),
      // Cadeia completa: leaf + CA. Sem a CA junto, o cliente que confia só na
      // raiz ainda assim não valida, por falta do elo intermediário.
      cert: existsSync(join(certDir, 'ca.crt'))
        ? Buffer.concat([readFileSync(join(certDir, 'local.crt')), readFileSync(join(certDir, 'ca.crt'))])
        : readFileSync(join(certDir, 'local.crt')),
    },
    (req, res) => {
      const up = httpRequest(
        { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502);
        res.end('origem indisponível');
      });
      req.pipe(up);
    },
  );

  tls.on('upgrade', (req, socket, head) => {
    // Repasse de upgrade tem três detalhes que, errados, deixam o socket
    // "aberto" para o cliente e mudo para sempre:
    //  1. o corpo que veio junto do handshake do cliente (`head`) vai para o
    //     upstream DEPOIS do upgrade, não antes;
    //  2. o resto que o upstream mandou junto do 101 (`upHead`) é ESCRITO no
    //     socket do cliente — usar unshift devolve o dado para o lado errado;
    //  3. o pipe é nos dois sentidos, encadear `a.pipe(b).pipe(a)` só liga um.
    const up = httpRequest({
      host: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });

    up.on('upgrade', (r, upSocket, upHead) => {
      const linhas = Object.entries(r.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`)
        .join('');
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? 'Switching Protocols'}\r\n${linhas}\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      socket.pipe(upSocket);
      upSocket.pipe(socket);
      const fim = () => {
        socket.destroy();
        upSocket.destroy();
      };
      socket.on('error', fim);
      upSocket.on('error', fim);
      socket.on('close', fim);
      upSocket.on('close', fim);
    });

    up.on('error', () => socket.destroy());
    up.end();
  });

  tls.listen(portaTls, '0.0.0.0', () =>
    console.log(`HTTPS (certificado próprio) em https://localhost:${portaTls}`),
  );
}
