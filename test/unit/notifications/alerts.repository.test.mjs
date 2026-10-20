import { describe, expect, it } from '@jest/globals';
import { avaliarAlertas } from '../../../dist/src/infra/database/repositories/alerts.repository.js';

describe('alerts repository avaliarAlertas', () => {
  it('enriquece disparos com slug canonico, foto e localizacao', async () => {
    const alerts = [
      {
        id: 5,
        owner_id: 12,
        created_at: '2026-10-10T10:00:00Z',
        label: 'Civic 2020',
        q: 'civic',
        filters: {},
        channels: ['sino', 'email'],
        email: 'user@example.test',
      },
    ];

    const lot = {
      id: 101,
      title_raw: 'HONDA CIVIC 2.0 SEDAN',
      title_display: 'Honda Civic 2.0 Sedan 2020',
      brand: 'Honda',
      model: 'Civic',
      year_model: 2020,
      doc_type: 'Recuperado',
      source_id: 'leilo',
      photos: ['https://img.example.test/foto1.jpg', 'https://img.example.test/foto2.jpg'],
      city: 'Curitiba',
      state: 'PR',
      lot_url: 'https://leiloeiro.test/lote/101',
      bid: 45000,
    };

    const queryMock = async (sql, params) => {
      if (sql.includes('FROM alerts WHERE enabled')) return alerts;
      if (sql.includes('FROM lots')) return [lot];
      if (sql.startsWith('INSERT INTO alert_hits')) return [{ lot_id: 101 }];
      if (sql.startsWith('UPDATE alerts SET last_run_at')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const disparos = await avaliarAlertas([101], queryMock);
    expect(disparos).toHaveLength(1);
    const d = disparos[0];
    expect(d.alertId).toBe(5);
    expect(d.lotId).toBe(101);
    expect(d.title).toBe('Honda Civic 2.0 Sedan 2020');
    expect(d.slug).toBe('honda-civic-2020-recuperado-leilo-101');
    expect(d.photoUrl).toBe('https://img.example.test/foto1.jpg');
    expect(d.city).toBe('Curitiba');
    expect(d.state).toBe('PR');
    expect(d.bid).toBe(45000);
  });
});
