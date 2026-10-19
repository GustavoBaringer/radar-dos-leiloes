import webpush from 'web-push';

export const VAPID_OK = Boolean(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (VAPID_OK) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? 'mailto:radar@localhost',
    process.env.VAPID_PUBLIC!,
    process.env.VAPID_PRIVATE!,
  );
}

export const enviarWebPush = webpush.sendNotification.bind(webpush);

export function canaisDisponiveis(): { push: boolean; email: boolean } {
  return { push: VAPID_OK, email: Boolean(process.env.SMTP_HOST) };
}

export function avisarCanaisIndisponiveis(): void {
  const canais = canaisDisponiveis();
  if (!canais.push) console.warn('[alerta] push indisponível: VAPID_PUBLIC/VAPID_PRIVATE ausentes');
  if (!canais.email) console.warn('[alerta] e-mail indisponível: SMTP_HOST ausente — disparos de e-mail ficam pendentes');
}
