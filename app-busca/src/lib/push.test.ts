import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';
import { sincronizarPushAutorizado } from './push';

test('syncs an existing authorized subscription only; never prompts and reports failures', async () => {
  const root = globalThis as typeof globalThis & { window: any; navigator: any; Notification: any };
  const old = {
    window: Object.getOwnPropertyDescriptor(root, 'window'),
    navigator: Object.getOwnPropertyDescriptor(root, 'navigator'),
    Notification: Object.getOwnPropertyDescriptor(root, 'Notification'),
    subscribe: api.inscreverPush,
  };
  const setGlobal = (key: 'window' | 'navigator' | 'Notification', value: unknown) =>
    Object.defineProperty(root, key, { configurable: true, writable: true, value });
  let synced: unknown;
  try {
    const subscription = { toJSON: () => ({ endpoint: 'https://push.invalid', expirationTime: 123 }) };
    setGlobal('window', { isSecureContext: true, PushManager: {} });
    setGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } });
    setGlobal('Notification', { permission: 'granted' });
    api.inscreverPush = async (value) => { synced = value; return undefined; };
    assert.deepEqual(await sincronizarPushAutorizado(), { ok: true });
    assert.deepEqual(synced, subscription.toJSON());

    for (const permission of ['denied', 'default']) {
      setGlobal('Notification', { permission });
      assert.deepEqual(await sincronizarPushAutorizado(), { ok: false });
    }
    setGlobal('Notification', { permission: 'granted' });
    api.inscreverPush = async () => { throw new Error('backend unavailable'); };
    await assert.rejects(sincronizarPushAutorizado(), /backend unavailable/);
  } finally {
    for (const key of ['window', 'navigator', 'Notification'] as const) {
      if (old[key]) Object.defineProperty(root, key, old[key]);
      else delete (root as any)[key];
    }
    api.inscreverPush = old.subscribe;
  }
});
