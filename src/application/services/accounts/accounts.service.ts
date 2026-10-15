import { Inject, Injectable } from '@nestjs/common';
import { createAccountContext, buildMePayload } from '../../../core/account-context.js';
import type { Identidade } from '../../../domain/identity/identidade.js';
import type { Alerta } from '../../../domain/alerts/alert-types.js';
import { toPublicAlert, toPublicFavorite, toPublicHit } from '../../../domain/lots/public-dto.js';
import { celularValido, documento, emailValido } from '../../../domain/identity/cadastro.js';
import { BoundedInputError, paginateRows, parsePagination, safePositiveId, ValidateAlertInput } from '../../../domain/search/request-bounds.js';
import { ACCOUNTS_QUERY, AccountsRepository, type AccountsQuery } from '../../../infra/database/repositories/accounts.repository.js';

export const REGISTRATION_THROTTLE = 'REGISTRATION_THROTTLE';
export const ALERT_CANDIDATE_COUNTER = 'ALERT_CANDIDATE_COUNTER';
export const ACCOUNTS_RUNTIME_CONFIG = 'ACCOUNTS_RUNTIME_CONFIG';

export type AccountActor = Identidade;
export interface RegistrationThrottle { consume(ip: string): Promise<boolean> }
export type AlertCandidateCounter = (alert: Alerta) => Promise<number>;
export interface AccountsRuntimeConfig {
  publicKey: string | null;
  pushAvailable: boolean;
  emailAvailable: boolean;
  registrationThrottleEnabled: boolean;
}

export class AccountsServiceError extends Error {
  constructor(readonly statusCode: 400 | 401 | 404 | 429, message: string, readonly field?: string) {
    super(message);
    this.name = 'AccountsServiceError';
  }
}

function requireActor(actor: AccountActor): AccountActor {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId <= 0 || !['admin', 'comum'].includes(actor.papel)) {
    throw new AccountsServiceError(401, 'Autenticação necessária.');
  }
  return actor;
}

const plainRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null;
};

const texto = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : '';

@Injectable()
export class AccountsService {
  private readonly accountContext: ReturnType<typeof createAccountContext>;

  constructor(
    private readonly repository: AccountsRepository,
    @Inject(ACCOUNTS_QUERY) query: AccountsQuery,
    @Inject(REGISTRATION_THROTTLE) private readonly throttle: RegistrationThrottle,
    @Inject(ALERT_CANDIDATE_COUNTER) private readonly countCandidates: AlertCandidateCounter,
    @Inject(ACCOUNTS_RUNTIME_CONFIG) private readonly runtime: AccountsRuntimeConfig,
  ) {
    this.accountContext = createAccountContext(query);
  }

  async me(actorInput: AccountActor, context: { oidc: boolean; saiuEmDev: boolean }) {
    const actor = requireActor(actorInput);
    const logado = context.oidc ? actor.userId > 0 : !context.saiuEmDev;
    const identity = {
      papel: actor.papel,
      oidc: context.oidc,
      logado,
      conta: {
        id: logado ? actor.userId : 0,
        email: actor.email,
        nome: actor.nome,
        porProvedor: actor.sub != null,
      },
    };
    const summary = logado
      ? await this.accountContext.summarize(actor.userId)
      : { favoriteCount: 0, unreadAlertCount: 0 };
    return buildMePayload(identity, summary);
  }

  async listAlerts(actorInput: AccountActor, input: { page?: unknown; pageSize?: unknown }) {
    const actor = requireActor(actorInput);
    const { page, pageSize, offset } = parsePagination(input.page, input.pageSize);
    const [totals, rows] = await this.repository.listAlerts(actor.userId, pageSize + 1, offset);
    const pageRows = paginateRows(rows, page, pageSize);
    return { ...pageRows, items: pageRows.items.map(toPublicAlert), total: Number(totals[0]?.total ?? 0) };
  }

  async createAlert(actorInput: AccountActor, input: unknown) {
    const actor = requireActor(actorInput);
    const body = ValidateAlertInput(input);
    const q = body.q?.trim() ?? '';
    const channels = body.channels ?? ['sino'];
    const [alert] = await this.repository.createAlert({
      ownerId: actor.userId,
      label: body.label ?? (q || 'Alerta'),
      q: q || null,
      filters: body.filters ?? {},
      channels,
      email: body.email ?? null,
    });
    const candidates = await this.countCandidates({
      id: Number(alert.id), owner_id: actor.userId, created_at: '', label: alert.label,
      q: alert.q, filters: body.filters ?? {}, channels: alert.channels, email: alert.email,
    });
    return { ...toPublicAlert({ ...alert, total: 0, nao_vistos: 0 }), casados_agora: 0, no_indice_agora: candidates };
  }

  async updateAlert(actorInput: AccountActor, rawId: unknown, input: unknown) {
    const actor = requireActor(actorInput);
    const id = safePositiveId(rawId);
    if (id === null) throw new AccountsServiceError(400, 'id inválido');
    const body = ValidateAlertInput(input, { edit: true });
    const [alert] = await this.repository.updateAlert({
      id, ownerId: actor.userId, label: body.label ?? null,
      channels: body.channels ?? ['sino'], email: body.email ?? null,
    });
    if (!alert) throw new AccountsServiceError(404, 'alerta não encontrado');
    const [counts] = await this.repository.alertHitCounts(id);
    return toPublicAlert({ ...alert, total: counts?.total ?? 0, nao_vistos: counts?.nao_vistos ?? 0 });
  }

  async deleteAlert(actorInput: AccountActor, rawId: unknown) {
    const actor = requireActor(actorInput);
    const id = safePositiveId(rawId);
    if (id === null) throw new AccountsServiceError(400, 'id inválido');
    const deleted = await this.repository.deleteAlert(id, actor.userId);
    if (!deleted.length) throw new AccountsServiceError(404, 'alerta não encontrado');
    return { ok: true as const };
  }

  async listAlertHits(actorInput: AccountActor, input: Record<string, unknown>) {
    const actor = requireActor(actorInput);
    if (Object.keys(input).some((key) => !['naoVistos', 'page', 'pageSize', 'alertId'].includes(key))) {
      throw new BoundedInputError('Parâmetro de consulta inválido.');
    }
    const naoVistosInput = input.naoVistos;
    if (Array.isArray(naoVistosInput) || (naoVistosInput !== undefined && !['true', 'false'].includes(String(naoVistosInput)))) {
      throw new BoundedInputError('Parâmetro naoVistos inválido.');
    }
    const naoVistos = naoVistosInput === 'true' || naoVistosInput === true;
    const alertId = input.alertId === undefined ? null : safePositiveId(input.alertId);
    if (input.alertId !== undefined && alertId === null) throw new BoundedInputError('Parâmetro alertId inválido.');
    const { page, pageSize, offset } = parsePagination(input.page, input.pageSize);
    const { total, rows } = await this.repository.listAlertHits(actor.userId, naoVistos, alertId, pageSize + 1, offset);
    const pageRows = paginateRows(rows, page, pageSize);
    const lots = pageRows.items.map(toPublicHit);
    return { ...pageRows, items: await this.accountContext.decorateLots(actor.userId, lots), total };
  }

  async markAlertHitsSeen(actorInput: AccountActor, input: unknown) {
    const actor = requireActor(actorInput);
    const body = plainRecord(input) ?? {};
    const alertId = body.alertId === undefined ? null : safePositiveId(body.alertId);
    if (body.alertId !== undefined && alertId === null) throw new BoundedInputError('Parâmetro alertId inválido.');
    await this.repository.markAlertHitsSeen(actor.userId, alertId);
    return { ok: true as const };
  }

  async listFavorites(actorInput: AccountActor, input: { page?: unknown; pageSize?: unknown }) {
    const actor = requireActor(actorInput);
    const { page, pageSize, offset } = parsePagination(input.page, input.pageSize);
    const { total, rows } = await this.repository.listFavorites(actor.userId, pageSize + 1, offset);
    const pageRows = paginateRows(rows, page, pageSize);
    return { ...pageRows, items: pageRows.items.map((row) => ({ ...toPublicFavorite(row), favorited: true })), total };
  }

  async addFavorite(actorInput: AccountActor, input: unknown) {
    const actor = requireActor(actorInput);
    const body = plainRecord(input);
    if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'lotId')) throw new AccountsServiceError(400, 'corpo inválido');
    const lotId = safePositiveId(body.lotId, { allowString: false });
    if (lotId === null) throw new AccountsServiceError(400, 'lotId inválido');
    await this.repository.addFavorite(actor.userId, lotId);
    return { ok: true as const };
  }

  async deleteFavorite(actorInput: AccountActor, rawId: unknown) {
    const actor = requireActor(actorInput);
    const lotId = safePositiveId(rawId);
    if (lotId === null) throw new AccountsServiceError(400, 'lotId inválido');
    await this.repository.deleteFavorite(actor.userId, lotId);
    return { ok: true as const };
  }

  pushKey() {
    return { publicKey: this.runtime.publicKey };
  }

  async subscribePush(actorInput: AccountActor, input: unknown, userAgent?: string) {
    const actor = requireActor(actorInput);
    const body = plainRecord(input);
    if (!body || Object.keys(body).some((key) => !['endpoint', 'keys', 'expirationTime'].includes(key))
      || (body.expirationTime !== undefined && body.expirationTime !== null
        && (typeof body.expirationTime !== 'number' || !Number.isFinite(body.expirationTime) || body.expirationTime < 0))
      || typeof body.endpoint !== 'string' || body.endpoint.length > 4096) {
      throw new AccountsServiceError(400, 'inscrição inválida');
    }
    const keys = plainRecord(body.keys);
    if (!keys || Object.keys(keys).some((key) => !['p256dh', 'auth'].includes(key))
      || typeof keys.p256dh !== 'string' || keys.p256dh.length > 512 || !/^[A-Za-z0-9_+\/-]+=*$/.test(keys.p256dh)
      || typeof keys.auth !== 'string' || keys.auth.length > 512 || !/^[A-Za-z0-9_+\/-]+=*$/.test(keys.auth)) {
      throw new AccountsServiceError(400, 'inscrição inválida');
    }
    let endpoint: URL;
    try { endpoint = new URL(body.endpoint); } catch { throw new AccountsServiceError(400, 'inscrição inválida'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new AccountsServiceError(400, 'inscrição inválida');
    await this.repository.subscribe({
      endpoint: endpoint.toString(), p256dh: keys.p256dh, auth: keys.auth,
      userAgent: (userAgent ?? '').slice(0, 200), ownerId: actor.userId,
    });
    return { ok: true as const };
  }

  async notificationStatus(actorInput: AccountActor) {
    const actor = requireActor(actorInput);
    const subscriptions = await this.repository.subscriptions(actor.userId);
    return {
      canais: { push: this.runtime.pushAvailable, email: this.runtime.emailAvailable },
      publicKey: this.runtime.publicKey,
      dispositivos: subscriptions.map((subscription) => ({
        host: new URL(subscription.endpoint).host,
        failures: subscription.failures,
        desde: subscription.created_at,
      })),
    };
  }

  async joinWaitlist(input: unknown) {
    const body = plainRecord(input) ?? {};
    const email = String(body.email ?? '').trim().slice(0, 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AccountsServiceError(400, 'e-mail inválido');
    const consentimento = String(body.consentimento ?? '').trim().slice(0, 2000);
    if (!consentimento) throw new AccountsServiceError(400, 'consentimento ausente');
    await this.repository.waitlist({
      email, nome: String(body.nome ?? '').trim().slice(0, 120),
      interesse: String(body.interesse ?? '').trim().slice(0, 40), consentimento,
    });
    return { ok: true as const };
  }

  async register(input: unknown, ip: string) {
    if (this.runtime.registrationThrottleEnabled) {
      try {
        if (await this.throttle.consume(ip)) throw new AccountsServiceError(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
      } catch (error) {
        if (error instanceof AccountsServiceError) throw error;
        // The legacy registration path is fail-open when Redis is unavailable.
      }
    }
    const body = plainRecord(input) ?? {};
    const nome = texto(body.nome, 120).replace(/\s+/g, ' ');
    if (nome.length < 3 || nome.split(' ').length < 2) throw new AccountsServiceError(400, 'Informe seu nome completo.', 'nome');
    const doc = documento(body.documento);
    if (!doc) throw new AccountsServiceError(400, 'CPF ou CNPJ inválido.', 'documento');
    const email = texto(body.email, 200).toLowerCase();
    if (!emailValido(email)) throw new AccountsServiceError(400, 'E-mail inválido.', 'email');
    const celular = celularValido(body.celular);
    if (!celular) throw new AccountsServiceError(400, 'Celular inválido. Informe o DDD e o número.', 'celular');
    const consentimento = texto(body.consentimento, 2000);
    const versao = texto(body.consentimentoVersao, 40);
    if (!consentimento || !versao) throw new AccountsServiceError(400, 'É preciso aceitar os termos para continuar.', 'consentimento');
    await this.repository.register({
      nome, documento: doc.digitos, tipoDocumento: doc.tipo, email, celular,
      versao, consentimento, ip: ip || null, marketing: body.marketing === true,
      origem: texto(body.origem, 40),
    });
    return {
      ok: true as const,
      proximoPasso: 'pagamento' as const,
      mensagem: 'Cadastro recebido. Em seguida você recebe o link para ativar a assinatura de R$ 69,90/mês.',
    };
  }
}
