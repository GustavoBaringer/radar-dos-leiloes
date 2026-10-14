import { afterEach, describe, expect, it } from '@jest/globals';
import { AccountsService, AccountsServiceError } from '../../../dist/src/application/services/accounts/accounts.service.js';
import { AccountsRepository } from '../../../dist/src/infra/database/repositories/accounts.repository.js';

const userA = { userId: 11, sub: 'user-a', email: 'a@example.test', nome: 'A', papel: 'comum' };
const userB = { userId: 22, sub: 'user-b', email: 'b@example.test', nome: 'B', papel: 'comum' };
const admin = { userId: 1, sub: null, email: null, nome: 'Admin', papel: 'admin' };
const config = { publicKey: 'vapid-public', pushAvailable: true, emailAvailable: false, registrationThrottleEnabled: false };

function setup(overrides = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT count(*)::int AS total FROM alerts')) return [{ total: 1 }];
    if (sql.startsWith('SELECT lot_id FROM favorites')) return params[0] === userA.userId ? [{ lot_id: 83 }] : [];
    if (sql.includes('FROM alerts a WHERE a.owner_id')) return [{ id: 7, label: 'meu alerta', q: 'civic', channels: ['sino'], email: null, filters: {}, total: 2, nao_vistos: 1 }];
    if (sql.startsWith('INSERT INTO alerts')) return [{ id: 9, label: 'Civic', q: 'civic', channels: ['sino'], email: null, filters: {} }];
    if (sql.startsWith('UPDATE alerts SET')) return params[4] === userA.userId ? [{ id: params[0], label: 'editado', q: 'civic', channels: params[2], email: params[3], filters: {} }] : [];
    if (sql.includes('FROM alert_hits WHERE alert_id = $1')) return [{ total: 2, nao_vistos: 1 }];
    if (sql.startsWith('DELETE FROM alerts')) return params[1] === userA.userId ? [{ id: params[0] }] : [];
    if (sql.startsWith('SELECT count(*)::int AS total FROM (')) return [{ total: 1 }];
    if (sql.includes('FROM alert_hits h JOIN alerts a')) return [{ id: 83, source_id: 's', lot_url: null, title_raw: 'Honda Civic', title_display: 'Honda Civic', brand: 'Honda', model: 'Civic', status: 'aberto', asset_type: 'veiculo', photos: [], photo_count: 0, seen: false, labels: ['a', 'b'], alertas: 2, is_novo: false, effective_status: 'aberto', discount_pct: null }];
    if (sql.startsWith('UPDATE alert_hits SET seen')) return [];
    if (sql.startsWith('SELECT count(*)::int AS total FROM favorites')) return [{ total: 1 }];
    if (sql.includes('FROM favorites f JOIN lots l')) return [{ id: 83, source_id: 's', lot_url: null, title_raw: 'Honda Civic', title_display: 'Honda Civic', brand: 'Honda', model: 'Civic', status: 'aberto', asset_type: 'veiculo', photos: [], photo_count: 0, favorited_em: new Date(), is_novo: false, effective_status: 'aberto', discount_pct: null }];
    if (sql.startsWith('INSERT INTO favorites')) return [];
    if (sql.startsWith('DELETE FROM favorites')) return [];
    if (sql.startsWith('INSERT INTO espera')) return [];
    if (sql.startsWith('INSERT INTO cadastros')) return [];
    if (sql.startsWith('INSERT INTO push_subscriptions')) return [];
    if (sql.startsWith('SELECT endpoint, failures, created_at FROM push_subscriptions')) return [{ endpoint: 'https://push.example.test/x', failures: 2, created_at: new Date('2026-10-01T00:00:00Z') }];
    if (sql.startsWith('SELECT count(*)::int AS count') && sql.includes('FROM favorites f')) return [{ count: 3 }];
    if (sql.startsWith('SELECT count(*)::int AS count') && sql.includes('FROM alert_hits h')) return [{ count: 4 }];
    throw new Error(`Unexpected accounts SQL: ${sql}`);
  };
  const repository = new AccountsRepository(query);
  const throttle = overrides.throttle ?? { consume: async () => false };
  const counter = overrides.counter ?? (async () => 3);
  const service = new AccountsService(repository, query, throttle, counter, { ...config, ...overrides.config });
  return { calls, query, repository, service };
}

describe('AccountsService', () => {
  let fixture;
  afterEach(() => { fixture = undefined; });

  it('rejects missing actors before account queries and invalid alerts before persistence', async () => {
    fixture = setup();
    await expect(fixture.service.listAlerts(undefined, {})).rejects.toMatchObject({ statusCode: 401 });
    await expect(fixture.service.createAlert(userA, { unknown: true })).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
  });

  it('keeps alert reads and mutations owner-filtered for separate actors', async () => {
    fixture = setup();
    const list = await fixture.service.listAlerts(userA, {});
    expect(list).toMatchObject({ total: 1, items: [{ id: 7, total: 2, nao_vistos: 1 }] });
    expect(fixture.calls.filter(({ sql }) => sql.includes('owner_id = $1')).every(({ params }) => params[0] === userA.userId)).toBe(true);

    await expect(fixture.service.updateAlert(userB, '7', { label: 'troca' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(fixture.service.deleteAlert(userB, 7)).rejects.toMatchObject({ statusCode: 404 });
    expect(fixture.calls.find(({ sql }) => sql.startsWith('UPDATE alerts SET')).params[4]).toBe(userB.userId);
    expect(fixture.calls.find(({ sql }) => sql.startsWith('DELETE FROM alerts')).params[1]).toBe(userB.userId);

    await fixture.service.createAlert(userA, { q: 'civic' });
    const insert = fixture.calls.find(({ sql }) => sql.startsWith('INSERT INTO alerts'));
    expect(insert.params[5]).toBe(userA.userId);
  });

  it('keeps hits, favorites, seen changes and push subscriptions within the actor owner', async () => {
    fixture = setup();
    const hits = await fixture.service.listAlertHits(userB, { naoVistos: 'true', alertId: '7' });
    expect(hits.items[0]).toMatchObject({ id: 83, labels: ['a', 'b'], favorited: false });
    const hitRows = fixture.calls.filter(({ sql }) => sql.includes('FROM alert_hits h JOIN alerts a'));
    expect(hitRows.every(({ params }) => params[0] === userB.userId)).toBe(true);

    await fixture.service.markAlertHitsSeen(userB, { alertId: 7 });
    expect(fixture.calls.find(({ sql }) => sql.startsWith('UPDATE alert_hits SET seen')).params[0]).toBe(userB.userId);

    const favorites = await fixture.service.listFavorites(userA, {});
    expect(favorites.items[0]).toMatchObject({ id: 83, favorited: true });
    await fixture.service.addFavorite(userB, { lotId: 83 });
    await fixture.service.deleteFavorite(userB, '83');
    expect(fixture.calls.find(({ sql }) => sql.startsWith('INSERT INTO favorites')).params[0]).toBe(userB.userId);
    expect(fixture.calls.find(({ sql }) => sql.startsWith('DELETE FROM favorites')).params[0]).toBe(userB.userId);

    await fixture.service.subscribePush(userB, { endpoint: 'https://push.example.test/endpoint', keys: { p256dh: 'abc==', auth: 'def==' } }, 'fixture-agent');
    expect(fixture.calls.find(({ sql }) => sql.startsWith('INSERT INTO push_subscriptions')).params[4]).toBe(userB.userId);
    expect((await fixture.service.notificationStatus(userB)).dispositivos[0].host).toBe('push.example.test');
  });

  it('accepts absent/null/nonnegative numeric expirationTime and rejects invalid values without SQL', async () => {
    fixture = setup();
    const base = { endpoint: 'https://push.example.test/e', keys: { p256dh: 'abc==', auth: 'def==' } };
    for (const expirationTime of [undefined, null, 123]) {
      const payload = expirationTime === undefined ? base : { ...base, expirationTime };
      await fixture.service.subscribePush(userA, payload);
    }
    expect(fixture.calls.filter(({ sql }) => sql.startsWith('INSERT INTO push_subscriptions'))).toHaveLength(3);
    for (const expirationTime of ['123', -1, NaN]) {
      const count = fixture.calls.length;
      await expect(fixture.service.subscribePush(userA, { ...base, expirationTime })).rejects.toMatchObject({ statusCode: 400 });
      expect(fixture.calls).toHaveLength(count);
    }
    expect(fixture.service.pushKey()).toEqual({ publicKey: 'vapid-public' });
  });

  it('validates signup, observes registration throttle, and keeps public payloads bounded', async () => {
    fixture = setup();
    await expect(fixture.service.register({ nome: 'x' }, '127.0.0.1')).rejects.toMatchObject({ statusCode: 400, field: 'nome' });
    expect(fixture.calls).toHaveLength(0);

    fixture = setup({ config: { registrationThrottleEnabled: true }, throttle: { consume: async () => true } });
    await expect(fixture.service.register({}, '127.0.0.1')).rejects.toMatchObject({ statusCode: 429 });
    expect(fixture.calls).toHaveLength(0);

    fixture = setup();
    const response = await fixture.service.register({
      nome: 'Maria Silva', documento: '529.982.247-25', email: 'MARIA@example.test', celular: '(11) 98765-4321',
      consentimento: 'aceito', consentimentoVersao: 'v1', marketing: true, origem: 'landing', unknown: 'ignored',
    }, '127.0.0.1');
    expect(response).toMatchObject({ ok: true, proximoPasso: 'pagamento' });
    const insert = fixture.calls.find(({ sql }) => sql.startsWith('INSERT INTO cadastros'));
    expect(insert.params).toEqual(['Maria Silva', '52998224725', 'CPF', 'maria@example.test', '11987654321', 'v1', 'aceito', '127.0.0.1', true, 'landing']);

    await expect(fixture.service.joinWaitlist({ email: 'nope', consentimento: 'ok' })).rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.calls.filter(({ sql }) => sql.startsWith('INSERT INTO espera'))).toHaveLength(0);
  });
});
