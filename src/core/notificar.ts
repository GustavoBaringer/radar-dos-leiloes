import webpush from 'web-push';
import { query } from './db.js';
import { marcarNotificado, type Disparo } from './alerts.js';
import { agruparDisparos, mensagemResumo, urlDoAlerta } from './alerta-resumo.js';

/**
 * Entrega dos alertas. O sino é sempre gravado (é só uma linha em alert_hits);
 * push e e-mail dependem de configuração e falham de forma isolada, sem derrubar
 * os outros canais nem a coleta.
 */

const VAPID_OK = Boolean(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (VAPID_OK) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:radar@localhost',
    process.env.VAPID_PUBLIC!,
    process.env.VAPID_PRIVATE!,
  );
}

const moeda = (v?: number | null) =>
  v == null ? 'sem lance' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

interface PushDependencies {
  enabled: boolean;
  query: typeof query;
  send: typeof webpush.sendNotification;
  mark: typeof marcarNotificado;
}
const pushDependencies: PushDependencies = {
  enabled: VAPID_OK, query, send: webpush.sendNotification.bind(webpush), mark: marcarNotificado,
};

export async function enviarPush(disparos: Disparo[], deps: PushDependencies = pushDependencies) {
  if (!deps.enabled || !disparos.length) return 0;
  const alvos = disparos.filter((d) => d.channels.includes('push'));
  if (!alvos.length) return 0;

  /**
   * Inscrições agrupadas POR DONO. Antes o SELECT trazia todas e cada disparo
   * ia para todo aparelho inscrito: o alerta de um usuário chegava no celular
   * dos outros, junto com o título do lote que ele estava procurando.
   */
  const porDono = new Map<number, any[]>();
  for (const i of await deps.query<any>(
    'SELECT endpoint, p256dh, auth, owner_id FROM push_subscriptions WHERE failures < 5 AND owner_id IS NOT NULL',
  )) {
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
        await deps.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        enviados++;
        entregue = true;
      } catch (err: any) {
        // 404/410 = inscrição morta (app desinstalado, permissão revogada).
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await deps.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
        } else {
          await deps.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1', [s.endpoint]);
        }
      }
    }
    if (entregue) for (const lote of grupo) await deps.mark(lote.alertId, lote.lotId, 'push');
  }
  return enviados;
}

/**
 * E-mail depende de SMTP configurado. Sem SMTP_HOST o disparo fica PENDENTE e
 * é registrado — em vez de falhar calado e o usuário achar que foi enviado.
 */
interface EmailDependencies {
  env: NodeJS.ProcessEnv;
  send: (message: { from: string; to: string; subject: string; html: string; text: string }) => Promise<unknown>;
  mark: typeof marcarNotificado;
}
const escaparHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));
const urlSegura = (value: string | null) => {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : '#'; }
  catch { return '#'; }
};

export async function enviarEmail(disparos: Disparo[], deps?: EmailDependencies) {
  const env = deps?.env ?? process.env;
  const alvos = disparos.filter((d) => d.channels.includes('email') && d.email);
  if (!alvos.length) return { enviados: 0, pendentes: 0 };
  if (!env.SMTP_HOST) {
    console.warn(`[alerta] ${agruparDisparos(alvos).length} e-mail(s) pendentes: SMTP_HOST não configurado`);
    return { enviados: 0, pendentes: agruparDisparos(alvos).length };
  }

  const transporte = deps ? { sendMail: deps.send } : (await import('nodemailer')).createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const mark = deps?.mark ?? marcarNotificado;

  let enviados = 0;
  let pendentes = 0;
  for (const grupo of agruparDisparos(alvos)) {
    const a = grupo[0];
    const linhas = grupo
      .map((d) => `<li><a href="${escaparHtml(urlSegura(d.lotUrl))}">${escaparHtml(d.title)}</a> — <b>${moeda(d.bid)}</b> <small>(${escaparHtml(d.source)})</small></li>`)
      .join('');
    try {
      await transporte.sendMail({
        from: env.SMTP_FROM ?? 'Radar de Leilões <radar@localhost>',
        to: a.email!,
        subject: `Radar: ${mensagemResumo(a.label, grupo.length)}`,
        html: `<p>${escaparHtml(mensagemResumo(a.label, grupo.length))}</p><ul>${linhas}</ul>`,
        text: `${mensagemResumo(a.label, grupo.length)}\n\n${grupo.map((d) => `${d.title} — ${moeda(d.bid)} — ${urlSegura(d.lotUrl)}`).join('\n')}`,
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
