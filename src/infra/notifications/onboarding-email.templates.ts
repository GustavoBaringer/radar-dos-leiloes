const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

function safeInputs(name: string, url: string) {
  if (typeof name !== 'string' || typeof url !== 'string') throw new TypeError('Nome e URL devem ser textos.');
  if (/[\r\n]/.test(url)) throw new TypeError('URL inválida.');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TypeError('URL inválida.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new TypeError('URL HTTPS válida obrigatória.');
  const displayName = name.replace(/[\r\n\t]+/g, ' ').trim() || 'Olá';
  return { displayName, escapedName: escapeHtml(displayName), safeUrl: escapeHtml(url) };
}

function render({ name, url }: { name: string; url: string }, mode: 'activation' | 'invitation' | 'payment') {
  const { displayName, escapedName, safeUrl } = safeInputs(name, url);
  const activation = mode === 'activation';
  const payment = mode === 'payment';
  const subject = activation ? 'Acesse sua conta do Radar de Leilões' : payment ? 'Pagamento pendente — Radar de Leilões' : 'Continue sua assinatura do Radar de Leilões';
  const heading = activation ? 'Acesse sua conta' : payment ? 'Finalize seu pagamento' : 'Continue sua assinatura';
  const intro = activation
    ? 'O pagamento foi confirmado. Para começar, crie sua senha ou acesse sua conta no ambiente seguro de autenticação.'
    : payment ? 'Seu e-mail foi confirmado e o checkout está pronto. Conclua sua assinatura por R$ 69,90/mês.' : 'Seu cadastro está pronto para continuar. Conclua a assinatura por R$ 69,90 por mês.';
  const button = activation ? 'Criar senha ou acessar conta' : payment ? 'Concluir pagamento' : 'Continuar assinatura';
  const instruction = activation
    ? 'O link leva ao ambiente de autenticação para você definir uma senha ou acessar sua conta. Ele não é um login; depois da autenticação, você retorna ao Radar.'
    : payment ? 'O acesso à sua conta será liberado somente após a confirmação do pagamento. Mantenha este link privado; ele pode expirar.' : 'Este link retoma o cadastro e permite concluir o pagamento. A assinatura ainda não está confirmada.';
  const text = `${displayName},\n\n${heading}.\n\n${intro}\n\n${button}: ${url}\n\n${instruction}\n\nRadar de Leilões`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head><body style="margin:0;background:#05070f;color:#eef3ff;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#05070f"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;border:1px solid #1e2941;border-radius:16px;background:#0b1120"><tr><td style="padding:28px 28px 8px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="36" height="36" align="center" style="border:1px solid #2f6bff;border-radius:12px;background:#13224a;color:#22d3ee;font-size:18px">●</td><td style="padding-left:10px;font-family:'Space Grotesk',sans-serif;font-size:17px;font-weight:600">Radar de Leilões</td></tr></table></td></tr><tr><td style="padding:22px 28px 30px"><p style="margin:0 0 10px;color:#93a4c4">${escapedName},</p><h1 style="margin:0 0 14px;font-family:'Space Grotesk',sans-serif;font-size:26px;line-height:1.2;color:#eef3ff">${heading}</h1><p style="margin:0 0 24px;color:#c3cde0">${intro}</p><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#2f6bff" style="border-radius:999px"><a href="${safeUrl}" style="display:inline-block;padding:13px 22px;border-radius:999px;color:#fff;text-decoration:none;font-weight:700">${button}</a></td></tr></table><p style="margin:24px 0 8px;color:#93a4c4;font-size:13px">${instruction}</p><p style="margin:18px 0 0;color:#93a4c4;font-size:12px">Se o botão não funcionar, copie este endereço para o navegador:<br><a href="${safeUrl}" style="color:#5b8cff;overflow-wrap:anywhere">${safeUrl}</a></p></td></tr><tr><td style="border-top:1px solid #1e2941;padding:18px 28px;color:#6f809f;font-size:12px">Radar de Leilões</td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}

export function renderCheckoutInvitation(input: { name: string; url: string }): { subject: string; html: string; text: string } {
  return render(input, 'invitation');
}

export function renderActivationInvitation(input: { name: string; url: string }): { subject: string; html: string; text: string } {
  return render(input, 'activation');
}

export function renderCheckoutPaymentEmail(input: { name: string; url: string }): { subject: string; html: string; text: string } {
  return render(input, 'payment');
}
