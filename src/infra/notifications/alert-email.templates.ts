import type { Disparo } from '../../domain/alerts/alert-types.js';

const escapeHtml = (value: string) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[c]!);

function sanitizeUrl(url: string): string {
  const clean = String(url ?? '').replace(/[\r\n\t]/g, '').trim();
  if (/^javascript:/i.test(clean) || /^data:/i.test(clean)) return '#';
  return clean;
}

function formatMoeda(val: number | null | undefined): string {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(val);
  }
  return 'Sob consulta';
}

export interface RenderAlertEmailInput {
  label: string;
  alertId: number;
  disparos: Disparo[];
  siteUrl?: string;
}

export interface RenderedAlertEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderAlertEmail(input: RenderAlertEmailInput): RenderedAlertEmail {
  const label = input.label?.trim() || 'Alerta';
  const disparos = input.disparos ?? [];
  const qtd = disparos.length;
  const siteUrl = sanitizeUrl(input.siteUrl || 'http://localhost:4500').replace(/\/+$/, '');
  const alertId = input.alertId;

  const subject = `Radar: ${qtd} ${qtd === 1 ? 'novo lote encontrado' : 'novos lotes encontrados'} para "${label}"`;
  const viewAlertUrl = `${siteUrl}/alertas?alertId=${alertId}`;

  // Montagem dos cards HTML de cada lote
  const cardsHtml = disparos.map((d) => {
    const slug = d.slug || `lote-${d.lotId}`;
    const lotUrl = `${siteUrl}/lote/${slug}`;
    const safeLotUrl = escapeHtml(lotUrl);
    const safeTitle = escapeHtml(d.title || `Lote #${d.lotId}`);
    const valorFormatado = formatMoeda(d.bid);
    const safeFonte = escapeHtml(d.source || 'Leilão Oficial');
    const local = [d.city, d.state].filter(Boolean).join('/');
    const safeLocal = local ? escapeHtml(local) : null;
    const safePhoto = d.photoUrl ? escapeHtml(sanitizeUrl(d.photoUrl)) : null;

    const imgTag = safePhoto
      ? `<img src="${safePhoto}" alt="${safeTitle}" width="140" height="95" style="display:block;width:140px;height:95px;object-fit:cover;border-radius:8px;background:#05070f;" border="0">`
      : `<table role="presentation" width="140" height="95" cellspacing="0" cellpadding="0" border="0" style="width:140px;height:95px;border-radius:8px;background:#1e2941;text-align:center;"><tr><td style="color:#6f809f;font-size:12px;font-family:'DM Sans',sans-serif;">Sem foto</td></tr></table>`;

    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:16px;border:1px solid #1e2941;border-radius:12px;background:#10172a;overflow:hidden;">
        <tr>
          <td style="padding:16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td width="140" valign="top" style="padding-right:16px;">
                  <a href="${safeLotUrl}" target="_blank" style="text-decoration:none;display:block;">${imgTag}</a>
                </td>
                <td valign="top">
                  <a href="${safeLotUrl}" target="_blank" style="color:#eef3ff;text-decoration:none;font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:600;line-height:1.3;display:block;margin-bottom:8px;">${safeTitle}</a>
                  <div style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:700;color:#22d3ee;margin-bottom:6px;">
                    ${valorFormatado}
                  </div>
                  <div style="font-family:'DM Sans',sans-serif;font-size:12px;color:#93a4c4;margin-bottom:12px;">
                    ${safeLocal ? `<span>${safeLocal}</span> &bull; ` : ''}<span>Fonte: ${safeFonte}</span>
                  </div>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td bgcolor="#2f6bff" style="border-radius:999px;">
                        <a href="${safeLotUrl}" target="_blank" style="display:inline-block;padding:8px 16px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Ver lote no Radar &rarr;</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }).join('');

  // Template HTML completo
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#05070f;color:#eef3ff;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#05070f;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;border:1px solid #1e2941;border-radius:16px;background:#0b1120;">
          <!-- Header -->
          <tr>
            <td style="padding:28px 28px 20px;border-bottom:1px solid #1e2941;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="36" height="36" align="center" style="border:1px solid #2f6bff;border-radius:12px;background:#13224a;color:#22d3ee;font-size:18px;font-weight:bold;">&bull;</td>
                  <td style="padding-left:12px;font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;color:#eef3ff;">Radar de Leilões</td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding:24px 28px 28px;">
              <div style="font-family:'DM Sans',sans-serif;font-size:13px;color:#93a4c4;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Alerta Ativo</div>
              <h1 style="margin:0 0 12px;font-family:'Space Grotesk',sans-serif;font-size:22px;line-height:1.3;color:#eef3ff;">
                Encontramos ${qtd} ${qtd === 1 ? 'novo lote' : 'novos lotes'} para &ldquo;${escapeHtml(label)}&rdquo;
              </h1>
              <p style="margin:0 0 24px;font-size:14px;color:#c3cde0;">
                Estes lotes entraram recentemente no monitoramento e correspondem aos critérios que você salvou.
              </p>
              
              <!-- Cards de Lotes -->
              ${cardsHtml}

              <!-- Ação Principal Rodapé -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:20px;">
                <tr>
                  <td align="center" style="padding:16px;background:#10172a;border:1px solid #1e2941;border-radius:12px;">
                    <a href="${escapeHtml(viewAlertUrl)}" target="_blank" style="display:inline-block;padding:12px 24px;background:#2f6bff;color:#ffffff;text-decoration:none;font-family:'DM Sans',sans-serif;font-weight:700;font-size:14px;border-radius:999px;">
                      Ver todos os resultados deste alerta no Radar
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #1e2941;padding:20px 28px;color:#6f809f;font-size:12px;font-family:'DM Sans',sans-serif;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    Radar de Leilões &bull; Monitoramento inteligente de leilões oficiais em todo o Brasil.<br>
                    Você recebeu este e-mail porque configurou alertas na sua conta.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Versão Texto Puro estruturada
  const textCards = disparos.map((d) => {
    const slug = d.slug || `lote-${d.lotId}`;
    const lotUrl = `${siteUrl}/lote/${slug}`;
    const valor = formatMoeda(d.bid);
    const local = [d.city, d.state].filter(Boolean).join('/');
    return `${d.title || `Lote #${d.lotId}`}\nValor: ${valor}${local ? ` · ${local}` : ''} · Fonte: ${d.source}\nVer no Radar: ${lotUrl}`;
  }).join('\n\n---\n\n');

  const text = `Radar de Leilões\n\nEncontramos ${qtd} ${qtd === 1 ? 'novo lote' : 'novos lotes'} para o seu alerta "${label}":\n\n${textCards}\n\nVer todos os resultados no Radar: ${viewAlertUrl}\n\nRadar de Leilões`;

  return { subject, html, text };
}
