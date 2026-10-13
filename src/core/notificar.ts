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

/**
 * O que o servidor consegue entregar AGORA. A tela de alertas usa para avisar
 * que o canal escolhido não vai sair: sem isto, marcar "e-mail" num alerta com o
 * SMTP ausente produz um disparo que nunca chega e nenhum sinal de por quê.
 */
export function canaisDisponiveis(): { push: boolean; email: boolean } {
  return { push: VAPID_OK, email: Boolean(process.env.SMTP_HOST) };
}

/**
 * Sem VAPID o push era descartado em silêncio (`enviarPush` devolvia 0 sem log),
 * que é exatamente o defeito que o usuário reportou: a tela mostrava o alerta
 * e nada chegava, sem nenhum sinal nos logs.
 */
export function avisarCanaisIndisponiveis(): void {
  const canais = canaisDisponiveis();
  if (!canais.push) console.warn('[alerta] push indisponível: VAPID_PUBLIC/VAPID_PRIVATE ausentes');
  if (!canais.email) console.warn('[alerta] e-mail indisponível: SMTP_HOST ausente — disparos de e-mail ficam pendentes');
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

/**
 * Quando foi o último aviso ENTREGUE deste alerta neste canal.
 *
 * `alert_hits.created_at` é a hora do disparo e `notified` guarda os canais que
 * saíram: `max()` dos hits que já têm o canal é, na prática, a última entrega —
 * sem coluna nova e sem migração.
 */
async function ultimaEntrega(alertId: number, canal: string, deps: { query: typeof query }): Promise<number | null> {
  const [r] = await deps.query<{ ultimo: string | null }>(
    'SELECT max(created_at)::text AS ultimo FROM alert_hits WHERE alert_id = $1 AND $2 = ANY(notified)',
    [alertId, canal],
  );
  return r?.ultimo ? Date.parse(r.ultimo) : null;
}

/**
 * Separa o que entra na entrega agora do que fica para a próxima janela.
 *
 * O hit já foi gravado por `avaliarAlertas` — isto só decide **push e e-mail**.
 * Push e e-mail têm janelas independentes: o mesmo lote pode sair por push agora
 * e esperar o e-mail da próxima janela, sem perder nenhum dos dois.
 */
export async function aplicarLimitesDeEntrega(
  disparos: Disparo[],
  limites: LimitesEntrega,
  deps: { query: typeof query } = { query },
): Promise<{ disparos: Disparo[]; adiados: number }> {
  const janela = new Map<string, number>();
  const dentroDaJanela = async (alertId: number, canal: 'push' | 'email', minutos: number) => {
    const chave = `${alertId}:${canal}`;
    const marcado = janela.get(chave);
    if (marcado !== undefined) return marcado;
    const ultima = await ultimaEntrega(alertId, canal, deps);
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
    requireTLS: true,
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
