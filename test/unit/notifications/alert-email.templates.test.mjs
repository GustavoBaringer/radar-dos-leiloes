import { describe, expect, it } from '@jest/globals';
import { renderAlertEmail } from '../../../dist/src/infra/notifications/alert-email.templates.js';

describe('alert-email.templates', () => {
  const disparos = [
    {
      alertId: 42,
      ownerId: 7,
      label: 'Civic 2020',
      channels: ['email'],
      email: 'user@example.test',
      lotId: 501,
      title: 'Honda Civic EXL 2.0 2020',
      lotUrl: 'https://leiloeiro-externo.test/lote/501',
      bid: 85000,
      source: 'freitas',
      slug: 'honda-civic-exl-2020-501',
      photoUrl: 'https://img.radar.test/foto501.webp',
      city: 'São Paulo',
      state: 'SP',
    },
    {
      alertId: 42,
      ownerId: 7,
      label: 'Civic 2020',
      channels: ['email'],
      email: 'user@example.test',
      lotId: 502,
      title: 'Honda Civic Touring Turbo',
      lotUrl: 'https://leiloeiro-externo.test/lote/502',
      bid: 110000,
      source: 'sodre',
      slug: 'honda-civic-touring-turbo-502',
      photoUrl: null,
      city: 'Campinas',
      state: 'SP',
    },
  ];

  it('renders alert email with Radar Design System palette and typography', () => {
    const result = renderAlertEmail({
      label: 'Civic 2020',
      alertId: 42,
      disparos,
      siteUrl: 'https://radar.example.test',
    });

    expect(result.subject).toBe('Radar: 2 novos lotes encontrados para "Civic 2020"');
    expect(result.html).toContain('#05070f'); // Fundo principal
    expect(result.html).toContain('#0b1120'); // Container principal
    expect(result.html).toContain('#1e2941'); // Borda do DS
    expect(result.html).toContain('#2f6bff'); // Primária Radar
    expect(result.html).toContain('#22d3ee'); // Accent cyan
    expect(result.html).toContain('Space Grotesk');
    expect(result.html).toContain('DM Sans');
    expect(result.html).toContain('Radar de Leilões');
  });

  it('directs lot links to internal Radar URL instead of external auctioneer', () => {
    const result = renderAlertEmail({
      label: 'Civic 2020',
      alertId: 42,
      disparos,
      siteUrl: 'https://radar.example.test',
    });

    // Deve conter os links internos canônicos
    expect(result.html).toContain('href="https://radar.example.test/lote/honda-civic-exl-2020-501"');
    expect(result.html).toContain('href="https://radar.example.test/lote/honda-civic-touring-turbo-502"');
    // Não deve apontar para o leiloeiro externo
    expect(result.html).not.toContain('https://leiloeiro-externo.test');

    // Link para ver todos os resultados no Radar
    expect(result.html).toContain('href="https://radar.example.test/alertas?alertId=42"');
  });

  it('renders structured plain text with internal Radar links', () => {
    const result = renderAlertEmail({
      label: 'Civic 2020',
      alertId: 42,
      disparos,
      siteUrl: 'https://radar.example.test',
    });

    expect(result.text).toContain('Honda Civic EXL 2.0 2020');
    expect(result.text).toContain('Ver no Radar: https://radar.example.test/lote/honda-civic-exl-2020-501');
    expect(result.text).toContain('Ver no Radar: https://radar.example.test/lote/honda-civic-touring-turbo-502');
    expect(result.text).toContain('Ver todos os resultados no Radar: https://radar.example.test/alertas?alertId=42');
    expect(result.text).not.toContain('https://leiloeiro-externo.test');
  });

  it('neutralizes malicious markup and unsafe protocols', () => {
    const maliciousDisparo = [
      {
        alertId: 99,
        ownerId: 1,
        label: '<script>alert(1)</script>',
        channels: ['email'],
        email: 'attacker@example.test',
        lotId: 666,
        title: '<img src=x onerror=alert(2)> Malicious Title',
        lotUrl: 'javascript:alert(3)',
        bid: 1000,
        source: '<b>evil</b>',
        slug: 'slug-666',
        photoUrl: 'javascript:alert(4)',
      },
    ];

    const result = renderAlertEmail({
      label: '<script>alert(1)</script>',
      alertId: 99,
      disparos: maliciousDisparo,
      siteUrl: 'https://radar.example.test',
    });

    expect(result.html).not.toContain('<script>alert(1)</script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<img src=x onerror=alert(2)>');
    expect(result.html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(result.html).not.toContain('javascript:');
  });
});
