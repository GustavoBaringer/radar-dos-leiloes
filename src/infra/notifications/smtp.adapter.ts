export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function criarTransporteSmtp(env: NodeJS.ProcessEnv): Promise<{
  sendMail: (message: EmailMessage) => Promise<unknown>;
  close: () => void;
}> {
  return (await import('nodemailer')).createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    requireTLS: true,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}
