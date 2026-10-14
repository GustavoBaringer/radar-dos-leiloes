import { Inject, Injectable } from '@nestjs/common';
import { COOKIE, criarToken } from '../../../core/auth.js';
import { idDoSlug } from '../../../domain/lots/slug.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { PAGINA_LOGIN } from '../../../infra/web/login-template.js';

const DESTINO_PADRAO = '/busca';
const APP_ROTAS = ['/busca', '/alertas', '/favoritos', '/cobertura'];
const escapaAtributo = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export interface AuthOrigin { protocol: string; host: string; forwardedProto?: string; secure: boolean }
export interface AuthPlan { status?: number; location?: string; cookies?: string[]; contentType?: string; body?: unknown }
export interface PasswordLoginInput { body: { usuario?: unknown; senha?: unknown; de?: unknown }; ip: string; origin: AuthOrigin }
export interface CallbackInput { query: { code?: string; state?: string; error?: string; iss?: string }; cookie?: string; origin: AuthOrigin }

@Injectable()
export class AuthService {
  constructor(@Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}

  private destination(raw: unknown): string {
    const value = String(raw ?? '');
    if (!value.startsWith('/') || value.startsWith('//')) return DESTINO_PADRAO;
    const path = value.split('?')[0]!;
    return path === '/' || APP_ROTAS.includes(path) || (path.startsWith('/lote/') && idDoSlug(path.slice(6)) !== null) ? value : DESTINO_PADRAO;
  }
  private loginHtml(de: unknown, error = ''): string {
    return PAGINA_LOGIN.replace('__DE__', escapaAtributo(this.destination(de)))
      .replace('__ABERTO__', error ? '1' : '0').replace('__ERRO__', error);
  }
  private callbackUri(origin: AuthOrigin): string {
    const proto = String(origin.forwardedProto ?? origin.protocol ?? 'http').split(',')[0];
    return `${proto}://${origin.host}/auth/callback`;
  }
  private sessionCookie(origin: AuthOrigin, value: string, maxAge = 30 * 24 * 3600): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.secure ? '; Secure' : ''}`;
  }
  private async redis() { return this.context.redisResource('login'); }
  private async attempts(ip: string): Promise<number> {
    try { return Number(await (await this.redis()).get(`login:falha:${ip}`)) || 0; } catch { return 0; }
  }
  private async failedAttempt(ip: string): Promise<void> {
    try {
      const redis = await this.redis();
      const key = `login:falha:${ip}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, 900);
    } catch { /* Legacy login remains available if Redis is unavailable. */ }
  }

  loginPage(query: { de?: unknown }): AuthPlan {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: this.loginHtml(query.de) };
  }

  async passwordLogin(input: PasswordLoginInput): Promise<AuthPlan> {
    const { body, ip, origin } = input;
    if (await this.attempts(ip) >= 8) return {
      status: 429, contentType: 'text/html; charset=utf-8',
      body: this.loginHtml(body.de, '<div class="erro">Muitas tentativas. Aguarde 15 minutos.</div>'),
    };
    let identity: Awaited<ReturnType<typeof this.context.oidc.loginPorSenha>>;
    try { identity = await this.context.oidc.loginPorSenha((body.usuario ?? '') as string, (body.senha ?? '') as string); }
    catch { return { status: 502, contentType: 'text/html; charset=utf-8', body: this.loginHtml(body.de, '<div class="erro">Provedor de identidade indisponível. Tente em instantes.</div>') }; }
    if (!identity) {
      await this.failedAttempt(ip);
      return { status: 401, contentType: 'text/html; charset=utf-8', body: this.loginHtml(body.de, '<div class="erro">Usuário ou senha incorretos.</div>') };
    }
    const user = await this.context.identity.garantirUsuario({ sub: identity.sub, email: identity.email, nome: identity.nome, papel: identity.papel });
    const token = criarToken(user.papel, user.sub);
    try { await (await this.redis()).del(`login:falha:${ip}`); } catch { /* Counter cleanup is best effort. */ }
    return { status: 302, location: this.destination(body.de), cookies: [this.sessionCookie(origin, token)] };
  }

  async oidcLogin(query: { de?: unknown }, origin: AuthOrigin): Promise<AuthPlan> {
    if (!this.context.oidc.oidcLigado()) return { status: 404, body: { erro: 'OIDC desligado' } };
    try {
      const { url, cookie } = await this.context.oidc.iniciarLogin(this.callbackUri(origin), this.destination(query.de));
      return { status: 302, location: url, cookies: [`${this.context.oidc.COOKIE_PKCE}=${cookie}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`] };
    } catch {
      return { status: 502, contentType: 'text/html; charset=utf-8', body: this.loginHtml('', '<div class="erro">Provedor de identidade indisponível. Use usuário e senha.</div>') };
    }
  }

  async callback(input: CallbackInput): Promise<AuthPlan> {
    if (!this.context.oidc.oidcLigado()) return { status: 404, body: { erro: 'OIDC desligado' } };
    const query = input.query;
    const configuredIssuer = (this.context.env.OIDC_ISSUER ?? '').replace(/\/$/, '');
    if (query.iss !== undefined && query.iss !== configuredIssuer) {
      return { status: 400, contentType: 'text/html; charset=utf-8', body: this.loginHtml('', '<div class="erro">Issuer do provedor inválido.</div>') };
    }
    if (query.error) return { status: 400, contentType: 'text/html; charset=utf-8', body: this.loginHtml('', `<div class="erro">Login cancelado no provedor (${escapaAtributo(String(query.error).slice(0, 40))}).</div>`) };
    try {
      const identity = await this.context.oidc.concluirLogin({
        code: String(query.code ?? ''), state: String(query.state ?? ''), cookiePkce: input.cookie,
        redirectUri: this.callbackUri(input.origin),
      });
      const user = await this.context.identity.garantirUsuario({ sub: identity.sub, email: identity.email, nome: identity.nome, papel: identity.papel });
      return {
        status: 302, location: this.destination(identity.destino),
        cookies: [this.sessionCookie(input.origin, criarToken(user.papel, user.sub)),
          `${this.context.oidc.COOKIE_PKCE}=; Path=/auth; Max-Age=0`,
          `${this.context.oidc.COOKIE_OIDC}=1; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`],
      };
    } catch (error) {
      return { status: 400, contentType: 'text/html; charset=utf-8', body: this.loginHtml('', `<div class="erro">Não foi possível concluir o login: ${escapaAtributo(String((error as Error)?.message ?? error).slice(0, 80))}</div>`) };
    }
  }

  async logout(input: { cookie?: string; origin: AuthOrigin }): Promise<AuthPlan> {
    const { cookie, origin } = input;
    const fromOidc = /(?:^|;\s*)radar_oidc=1/.test(cookie ?? '');
    const cookies = [this.sessionCookie(origin, '', 0), `${this.context.oidc.COOKIE_OIDC}=; Path=/; Max-Age=0`];
    const proto = String(origin.forwardedProto ?? origin.protocol ?? 'http').split(',')[0];
    let location = '/login';
    if (fromOidc && this.context.oidc.oidcLigado()) {
      try { location = await this.context.oidc.urlDeLogout(`${proto}://${origin.host}/login`) ?? '/login'; } catch { /* Local logout still succeeds. */ }
    }
    return { status: 302, location, cookies };
  }
}
