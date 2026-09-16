import webpush from 'web-push';
import { query } from './db.js';
import { marcarNotificado, type Disparo } from './alerts.js';

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

export async function enviarPush(disparos: Disparo[]) {
  if (!VAPID_OK || !disparos.length) return 0;
  const alvos = disparos.filter((d) => d.channels.includes('push'));
  if (!alvos.length) return 0;

  /**
   * Inscrições agrupadas POR DONO. Antes o SELECT trazia todas e cada disparo
   * ia para todo aparelho inscrito: o alerta de um usuário chegava no celular
   * dos outros, junto com o título do lote que ele estava procurando.
   */
  const porDono = new Map<number, any[]>();
  for (const i of await query<any>(
    'SELECT endpoint, p256dh, auth, owner_id FROM push_subscriptions WHERE failures < 5 AND owner_id IS NOT NULL',
  )) {
    const lista = porDono.get(Number(i.owner_id)) ?? [];
    lista.push(i);
    porDono.set(Number(i.owner_id), lista);
  }
  let enviados = 0;

  for (const d of alvos) {
    const inscricoes = porDono.get(d.ownerId) ?? [];
    if (!inscricoes.length) continue;
    const payload = JSON.stringify({
      title: `Novo lote: ${d.label}`,
      body: `${d.title.slice(0, 80)} — ${moeda(d.bid)}`,
      // `/` passou a ser a landing de venda, e `?lote=` nunca foi lido pelo app:
      // o push levava para marketing ou para a busca vazia. O id no fim do slug
      // é o que resolve o lote, então o texto antes dele é dispensável aqui.
      url: `/lote/alerta-${d.lotId}`,
      tag: `alerta-${d.alertId}-${d.lotId}`,
    });
    for (const s of inscricoes) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        enviados++;
      } catch (err: any) {
        // 404/410 = inscrição morta (app desinstalado, permissão revogada).
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
        } else {
          await query('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1', [s.endpoint]);
        }
      }
    }
    await marcarNotificado(d.alertId, d.lotId, 'push');
  }
  return enviados;
}

/**
 * E-mail depende de SMTP configurado. Sem SMTP_HOST o disparo fica PENDENTE e
 * é registrado — em vez de falhar calado e o usuário achar que foi enviado.
 */
export async function enviarEmail(disparos: Disparo[]) {
  const alvos = disparos.filter((d) => d.channels.includes('email') && d.email);
  if (!alvos.length) return { enviados: 0, pendentes: 0 };
  if (!process.env.SMTP_HOST) {
    console.warn(`[alerta] ${alvos.length} e-mail(s) pendentes: SMTP_HOST não configurado`);
    return { enviados: 0, pendentes: alvos.length };
  }

  const { createTransport } = await import('nodemailer');
  const transporte = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  // Um e-mail por alerta, com os lotes agrupados: 30 lotes novos não viram 30 e-mails.
  const porAlerta = new Map<number, Disparo[]>();
  for (const d of alvos) porAlerta.set(d.alertId, [...(porAlerta.get(d.alertId) ?? []), d]);

  let enviados = 0;
  for (const [, grupo] of porAlerta) {
    const a = grupo[0];
    const linhas = grupo
      .map((d) => `<li><a href="${d.lotUrl ?? '#'}">${d.title}</a> — <b>${moeda(d.bid)}</b> <small>(${d.source})</small></li>`)
      .join('');
    try {
      await transporte.sendMail({
        from: process.env.SMTP_FROM ?? 'Radar de Leilões <radar@localhost>',
        to: a.email!,
        subject: `${grupo.length} lote(s) novo(s) para "${a.label}"`,
        html: `<p>Seu alerta <b>${a.label}</b> encontrou ${grupo.length} lote(s):</p><ul>${linhas}</ul>`,
      });
      for (const d of grupo) await marcarNotificado(d.alertId, d.lotId, 'email');
      enviados++;
    } catch (err: any) {
      console.warn('[alerta] e-mail falhou:', err?.message);
    }
  }
  return { enviados, pendentes: 0 };
}
