/**
 * Provedor OIDC (Keycloak hoje; Cognito ou qualquer outro amanhã, trocando as
 * variáveis de ambiente).
 *
 * Fluxo: Authorization Code + PKCE. Não usamos o fluxo implícito nem guardamos
 * o `client_secret` no navegador — o código volta pela query string e a troca
 * pelo token acontece daqui, servidor a servidor.
 *
 * Fica DESLIGADO sem OIDC_ISSUER. O portão de senha continua sendo o padrão, e
 * ligar o OIDC é configuração, não deploy de código.
 */
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Papel } from './auth.js';

const ISSUER = (process.env.OIDC_ISSUER ?? '').replace(/\/$/, '');
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'radar-web';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? '';
/** Role do provedor que concede papel de admin aqui. O resto entra como comum. */
const ROLE_ADMIN = process.env.OIDC_ROLE_ADMIN ?? 'radar-admin';
const SEGREDO = process.env.APP_SESSAO_SEGREDO ?? randomBytes(32).toString('hex');

export const oidcLigado = () => ISSUER.length > 0;
export const COOKIE_OIDC = 'radar_oidc';
export const COOKIE_PKCE = 'radar_pkce';

interface Descoberta {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

/**
 * O documento de descoberta é buscado uma vez e guardado. Buscar a cada login
 * colocaria o Keycloak no caminho crítico de toda entrada, e ele reinicia mais
 * do que a nossa API.
 */
let descoberta: Promise<Descoberta> | null = null;
function descobrir(): Promise<Descoberta> {
  descoberta ??= fetch(`${ISSUER}/.well-known/openid-configuration`)
    .then((r) => {
      if (!r.ok) throw new Error(`descoberta OIDC falhou: HTTP ${r.status}`);
      return r.json() as Promise<Descoberta>;
    })
    .catch((e) => {
      // Sem isto um Keycloak fora do ar no primeiro login envenenaria o cache
      // com uma promessa rejeitada e o login ficaria quebrado até reiniciar.
      descoberta = null;
      throw e;
    });
  return descoberta;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function chaves() {
  jwks ??= createRemoteJWKSet(new URL((await descobrir()).jwks_uri));
  return jwks;
}

const base64url = (b: Buffer) => b.toString('base64url');

/**
 * Início do login. Devolve a URL do provedor e o estado que precisa voltar.
 *
 * `state` e `verificador` viajam num cookie assinado em vez de ficarem numa
 * tabela: são efêmeros (minutos) e guardá-los no banco criaria uma tabela de
 * lixo para expirar. O HMAC é o que impede o navegador de forjar o par.
 */
export async function iniciarLogin(redirectUri: string, destino: string) {
  const verificador = base64url(randomBytes(32));
  const desafio = base64url(createHash('sha256').update(verificador).digest());
  const state = base64url(randomBytes(16));
  const d = await descobrir();

  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', desafio);
  url.searchParams.set('code_challenge_method', 'S256');

  const carga = JSON.stringify({ state, verificador, destino });
  const assinatura = createHmac('sha256', SEGREDO).update(carga).digest('hex');
  return { url: url.toString(), cookie: `${Buffer.from(carga).toString('base64url')}.${assinatura}` };
}

function lerPkce(cookie?: string | null): { state: string; verificador: string; destino: string } | null {
  if (!cookie) return null;
  const [carga, assinatura] = String(cookie).split('.');
  if (!carga || !assinatura) return null;
  const texto = Buffer.from(carga, 'base64url').toString('utf8');
  const esperada = createHmac('sha256', SEGREDO).update(texto).digest('hex');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** O papel sai das roles do token, nunca de nada que o cliente mande. */
function papelDoToken(p: JWTPayload): Papel {
  const realm = (p as any).realm_access?.roles ?? [];
  const cliente = (p as any).resource_access?.[CLIENT_ID]?.roles ?? [];
  return [...realm, ...cliente].includes(ROLE_ADMIN) ? 'admin' : 'comum';
}

/**
 * Conclui o login: valida o `state`, troca o código pelo token e verifica a
 * assinatura do id_token contra o JWKS do provedor.
 *
 * A verificação é obrigatória mesmo o token vindo direto do endpoint por TLS:
 * é ela que garante issuer, audience e validade — sem isso um token de outro
 * realm do mesmo Keycloak seria aceito aqui.
 */
export async function concluirLogin(params: {
  code: string;
  state: string;
  cookiePkce?: string | null;
  redirectUri: string;
}): Promise<{ sub: string; email: string | null; nome: string | null; papel: Papel; destino: string }> {
  const guardado = lerPkce(params.cookiePkce);
  if (!guardado) throw new Error('estado de login ausente ou adulterado');
  // Comparação do state: é o que barra CSRF no callback.
  const a = Buffer.from(guardado.state);
  const b = Buffer.from(String(params.state ?? ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('state divergente');

  const d = await descobrir();
  const corpo = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: guardado.verificador,
  });
  if (CLIENT_SECRET) corpo.set('client_secret', CLIENT_SECRET);

  const r = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo,
  });
  if (!r.ok) throw new Error(`troca de código falhou: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const tokens = (await r.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error('provedor não devolveu id_token');

  const { payload } = await jwtVerify(tokens.id_token, await chaves(), {
    issuer: ISSUER,
    audience: CLIENT_ID,
  });
  if (!payload.sub) throw new Error('id_token sem sub');

  // O papel vem das roles, que no Keycloak ficam no access_token, não no
  // id_token. Verificamos os dois e usamos o que tiver a informação.
  let papel: Papel = papelDoToken(payload);
  if (papel !== 'admin' && tokens.access_token) {
    try {
      const { payload: acesso } = await jwtVerify(tokens.access_token, await chaves(), { issuer: ISSUER });
      papel = papelDoToken(acesso);
    } catch {
      /* access_token com audience de outro cliente: o papel continua o do id_token */
    }
  }

  return {
    sub: String(payload.sub),
    email: (payload.email as string) ?? null,
    nome: ((payload.name as string) || (payload.preferred_username as string)) ?? null,
    papel,
    destino: guardado.destino,
  };
}

/** URL de logout no provedor, para a sessão não sobreviver no Keycloak. */
export async function urlDeLogout(redirectUri: string): Promise<string | null> {
  const d = await descobrir();
  if (!d.end_session_endpoint) return null;
  const u = new URL(d.end_session_endpoint);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('post_logout_redirect_uri', redirectUri);
  return u.toString();
}
