import { Inject, Injectable } from '@nestjs/common';
import type { query } from '../../../infra/database/query.js';
import { marcarNotificado } from '../../../infra/database/repositories/alerts.repository.js';
import { NotificationSubscriptionsRepository, type PushSubscriptionRow } from '../../../infra/database/repositories/notification-subscriptions.repository.js';
import { VAPID_OK, enviarWebPush } from '../../../infra/notifications/web-push.adapter.js';
import { criarTransporteSmtp, type EmailMessage } from '../../../infra/notifications/smtp.adapter.js';
import type { Disparo } from '../../../domain/alerts/alert-types.js';
import { agruparDisparos, mensagemResumo, urlDoAlerta } from '../../../domain/alerts/alerta-resumo.js';
import { renderAlertEmail } from '../../../infra/notifications/alert-email.templates.js';

/**
 * Entrega dos alertas. O sino é sempre gravado (é só uma linha em alert_hits);
 * push e e-mail dependem de configuração e falham de forma isolada, sem derrubar
 * os outros canais nem a coleta.
 */

const moeda = (v?: number | null) =>
  v == null ? 'sem lance' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

export interface PushDependencies {
  enabled: boolean;
  query: typeof query;
  send: typeof enviarWebPush;
  mark: typeof marcarNotificado;
}

/**
 * Teto de entrega por alerta e por canal, em minutos.
 *
 * A cobertura diária visita 158 domínios entre 00:00 e 10:28: um modelo popular
 * em vários sites gera um disparo por site, e o usuário leva dezenas de avisos
 * sobre o mesmo carro. O limite é POR ALERTA: a janela só reabre quando passa o
 * tempo, e o aviso seguinte junta tudo o que entrou no meio.
 *
 * Zero (ou ausente) desliga o teto — é o caso das coletas regulares, onde cada
 * lote novo é um aviso por si.
 */
export type LimitesEntrega = { push?: number; email?: number };

export interface EmailDependencies {
  env: NodeJS.ProcessEnv;
  send: (message: EmailMessage) => Promise<unknown>;
  mark: typeof marcarNotificado;
}

export interface NotificationPorts {
  repository: Pick<NotificationSubscriptionsRepository, 'ultimaEntrega' | 'listarAtivas' | 'remover' | 'incrementarFalhas'>;
  push: Pick<PushDependencies, 'enabled' | 'send'>;
  env: NodeJS.ProcessEnv;
  smtp: typeof criarTransporteSmtp;
  mark: typeof marcarNotificado;
}

export const NOTIFICATION_PORTS = Symbol('NOTIFICATION_PORTS');

export const defaultNotificationPorts: NotificationPorts = {
  repository: new NotificationSubscriptionsRepository(),
  push: { enabled: VAPID_OK, send: enviarWebPush },
  env: process.env,
  smtp: criarTransporteSmtp,
  mark: marcarNotificado,
};

const escaparHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));
const urlSegura = (value: string | null) => {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : '#'; }
  catch { return '#'; }
};

@Injectable()
export class NotificationService {
  constructor(@Inject(NOTIFICATION_PORTS) private readonly ports: NotificationPorts = defaultNotificationPorts) {}

/**
 * Separa o que entra na entrega agora do que fica para a próxima janela.
 *
 * O hit já foi gravado por `avaliarAlertas` — isto só decide **push e e-mail**.
 * Push e e-mail têm janelas independentes: o mesmo lote pode sair por push agora
 * e esperar o e-mail da próxima janela, sem perder nenhum dos dois.
 */
async aplicarLimitesDeEntrega(
  disparos: Disparo[],
  limites: LimitesEntrega,
  deps?: { query: typeof query },
): Promise<{ disparos: Disparo[]; adiados: number }> {
  const repository = deps ? new NotificationSubscriptionsRepository(deps.query) : this.ports.repository;
  const janela = new Map<string, number>();
  const dentroDaJanela = async (alertId: number, canal: 'push' | 'email', minutos: number) => {
    const chave = `${alertId}:${canal}`;
    const marcado = janela.get(chave);
    if (marcado !== undefined) return marcado;
    const ultima = await repository.ultimaEntrega(alertId, canal);
    const fechado = ultima != null && Date.now() - ultima < minutos * 60_000;
    janela.set(chave, fechado ? 1 : 0);
    return fechado;
  };

  const entrega = new Map<string, Disparo>();
  let adiados = 0;
  for (const d of disparos) {
    const canais = d.channels.filter((c): c is 'push' | 'email' => c === 'push' || c === 'email');
    const livres: string[] = [];
    for (const canal of canais) {
      const minutos = limites[canal] ?? 0;
      // O resultado fica memoizado por alerta+canal: dozens de lotes do mesmo
      // disparo passam juntos na notificação agrupada, sem consumir janelas
      // diferentes entre si.
      if (minutos > 0 && await dentroDaJanela(d.alertId, canal, minutos)) { adiados++; continue; }
      livres.push(canal);
    }
    if (!livres.length) continue;
    entrega.set(`${d.alertId}:${d.lotId}`, {
      ...d,
      channels: livres.length === d.channels.length ? d.channels : [...d.channels.filter((c) => c === 'sino'), ...livres],
    });
  }
  return { disparos: [...entrega.values()], adiados };
}

async enviarPush(disparos: Disparo[], deps?: PushDependencies) {
  const repository = deps ? new NotificationSubscriptionsRepository(deps.query) : this.ports.repository;
  const push = deps ?? this.ports.push;
  const mark = deps?.mark ?? this.ports.mark;
  if (!push.enabled || !disparos.length) return 0;
  const alvos = disparos.filter((d) => d.channels.includes('push'));
  if (!alvos.length) return 0;

  /**
    * Inscrições agrupadas POR DONO. Antes a consulta trazia todas e cada disparo
   * ia para todo aparelho inscrito: o alerta de um usuário chegava no celular
   * dos outros, junto com o título do lote que ele estava procurando.
   */
  const porDono = new Map<number, PushSubscriptionRow[]>();
  for (const i of await repository.listarAtivas()) {
    const lista = porDono.get(Number(i.owner_id)) ?? [];
    lista.push(i);
    porDono.set(Number(i.owner_id), lista);
  }
  let enviados = 0;

  for (const grupo of agruparDisparos(alvos)) {
    const d = grupo[0];
    const inscricoes = porDono.get(d.ownerId) ?? [];
    if (!inscricoes.length) continue;
    const payload = JSON.stringify({
      title: 'Radar',
      body: mensagemResumo(d.label, grupo.length),
      url: urlDoAlerta(d.alertId),
      tag: `alerta-${d.alertId}-${grupo[0].lotId}`,
    });
    let entregue = false;
    for (const s of inscricoes) {
      try {
        await push.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        enviados++;
        entregue = true;
      } catch (err: any) {
        // 404/410 = inscrição morta (app desinstalado, permissão revogada).
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await repository.remover(s.endpoint);
        } else {
          await repository.incrementarFalhas(s.endpoint);
        }
      }
    }
    if (entregue) for (const lote of grupo) await mark(lote.alertId, lote.lotId, 'push');
  }
  return enviados;
}

/**
 * E-mail depende de SMTP configurado. Sem SMTP_HOST o disparo fica PENDENTE e
 * é registrado — em vez de falhar calado e o usuário achar que foi enviado.
 */
async enviarEmail(disparos: Disparo[], deps?: EmailDependencies) {
  const env = deps?.env ?? this.ports.env;
  const alvos = disparos.filter((d) => d.channels.includes('email') && d.email);
  if (!alvos.length) return { enviados: 0, pendentes: 0 };
  if (!env.SMTP_HOST) {
    console.warn(`[alerta] ${agruparDisparos(alvos).length} e-mail(s) pendentes: SMTP_HOST não configurado`);
    return { enviados: 0, pendentes: agruparDisparos(alvos).length };
  }

  const transporte = deps ? { sendMail: deps.send } : await this.ports.smtp(env);
  const mark = deps?.mark ?? this.ports.mark;

  let enviados = 0;
  let pendentes = 0;
  for (const grupo of agruparDisparos(alvos)) {
    const a = grupo[0];
    const siteUrl = env.PUBLIC_URL || env.SITE_URL || 'http://localhost:4500';
    const emailData = renderAlertEmail({
      label: a.label,
      alertId: a.alertId,
      disparos: grupo,
      siteUrl,
    });
    try {
      await transporte.sendMail({
        from: env.SMTP_FROM ?? 'Radar de Leilões <radar@localhost>',
        to: a.email!,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      });
      for (const d of grupo) await mark(d.alertId, d.lotId, 'email');
      enviados++;
    } catch (err: any) {
      pendentes++;
      console.warn('[alerta] e-mail falhou:', err?.message);
    }
  }
  return { enviados, pendentes };
}
}

const notificationService = new NotificationService();
export const aplicarLimitesDeEntrega = notificationService.aplicarLimitesDeEntrega.bind(notificationService);
export const enviarPush = notificationService.enviarPush.bind(notificationService);
export const enviarEmail = notificationService.enviarEmail.bind(notificationService);
