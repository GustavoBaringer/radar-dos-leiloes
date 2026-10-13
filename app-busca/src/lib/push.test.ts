import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';
import { sincronizarPushAutorizado } from './push';

test('reconciles an existing authorized subscription and repairs a missing one', async (t) => {
  const root = globalThis as typeof globalThis & { window: any; navigator: any; Notification: any };
  const old = {
    window: Object.getOwnPropertyDescriptor(root, 'window'),
    navigator: Object.getOwnPropertyDescriptor(root, 'navigator'),
    Notification: Object.getOwnPropertyDescriptor(root, 'Notification'),
    subscribe: api.inscreverPush,
    chave: api.chavePush,
    register: navigator?.serviceWorker?.register,
  };
  const setGlobal = (key: 'window' | 'navigator' | 'Notification', value: unknown) =>
    Object.defineProperty(root, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const key of ['window', 'navigator', 'Notification'] as const) {
      if (old[key]) Object.defineProperty(root, key, old[key]);
      else delete (root as any)[key];
    }
    api.inscreverPush = old.subscribe;
    api.chavePush = old.chave;
  });

  const subscription = { toJSON: () => ({ endpoint: 'https://push.invalid', expirationTime: 123 }) };

  await t.test('existing subscription is synced without prompting', async () => {
    let synced: unknown;
    setGlobal('window', { isSecureContext: true, PushManager: {} });
    setGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } });
    setGlobal('Notification', { permission: 'granted' });
    api.inscreverPush = async (value) => { synced = value; return undefined; };
    assert.deepEqual(await sincronizarPushAutorizado(), { ok: true });
    assert.deepEqual(synced, subscription.toJSON());
  });

  await t.test('a missing service worker and subscription are re-created, not ignored', async () => {
    let registrado = false;
    let inscrito: unknown;
    let synced: unknown;
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async (options: unknown) => { inscrito = options; return subscription; },
      },
    };
    setGlobal('window', { isSecureContext: true, PushManager: {} });
    setGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => null,
        register: async (url: string) => {
          registrado = url === '/sw.js';
          await new Promise((r) => setTimeout(r, 0));
          return registration;
        },
        ready: Promise.resolve(registration),
      },
    });
    setGlobal('Notification', { permission: 'granted' });
    api.chavePush = async () => ({ publicKey: 'BHeSxa4PlTpk4FVAG2eiODTBQBgcovg4iiSqjsj4Kbj6gviOsvacO_d0c4YyBjFL0ZzBL8G6aNwHNV4g-AkiNGA' });
    api.inscreverPush = async (value) => { synced = value; return undefined; };

    assert.deepEqual(await sincronizarPushAutorizado(), { ok: true });
    assert.equal(registrado, true, 'o service worker ausente precisa ser registrado de novo');
    assert.deepEqual((inscrito as { userVisibleOnly: boolean }).userVisibleOnly, true);
    assert.ok((inscrito as { applicationServerKey: Uint8Array }).applicationServerKey instanceof Uint8Array);
    // Chave VAPID é um ponto P-256 não comprimido: 65 bytes (0x04 || X || Y).
    assert.equal((inscrito as { applicationServerKey: Uint8Array }).applicationServerKey.length, 65);
    assert.deepEqual(synced, subscription.toJSON());
  });

  await t.test('a server without VAPID key says so instead of staying silent', async () => {
    setGlobal('window', { isSecureContext: true, PushManager: {} });
    setGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => null,
        register: async () => ({ pushManager: { getSubscription: async () => null, subscribe: async () => subscription } }),
        ready: Promise.resolve(null),
      },
    });
    setGlobal('Notification', { permission: 'granted' });
    api.chavePush = async () => ({ publicKey: null });
    const r = await sincronizarPushAutorizado();
    assert.equal(r.ok, false);
    assert.ok(r.motivo, 'toda falha precisa de motivo: o silêncio é o defeito que se quer eliminar');
  });

  await t.test('every refused permission reports why', async () => {
    setGlobal('window', { isSecureContext: true, PushManager: {} });
    setGlobal('navigator', { serviceWorker: { getRegistration: async () => null } });
    for (const permission of ['denied', 'default'] as const) {
      setGlobal('Notification', { permission });
      const r = await sincronizarPushAutorizado();
      assert.deepEqual(r.ok, false);
      assert.ok(r.motivo && r.motivo.length > 0, `permissão ${permission} sem motivo`);
    }
    setGlobal('Notification', { permission: 'granted' });
    setGlobal('navigator', {
      serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
    });
    api.inscreverPush = async () => { throw new Error('backend unavailable'); };
    await assert.rejects(sincronizarPushAutorizado(), /backend unavailable/);
  });
});