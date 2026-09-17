import { api } from './api';

/** base64url -> Uint8Array, formato que o PushManager exige na chave VAPID. */
function chaveParaBytes(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function pushInscrito(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}

export function podePush(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window && window.isSecureContext;
}

/**
 * Liga a notificação do navegador neste aparelho.
 *
 * Devolve `false` com motivo em vez de lançar, porque o push é OPCIONAL: se o
 * navegador recusar, o alerta ainda tem de ser criado com os outros canais em
 * vez de a criação inteira falhar.
 */
export async function ativarPush(): Promise<{ ok: boolean; motivo?: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, motivo: 'Este navegador não suporta notificação push.' };
  }
  // Push exige origem segura. Em HTTP na rede local o navegador recusa calado.
  if (!window.isSecureContext) {
    return { ok: false, motivo: 'Push só funciona em HTTPS. Use o endereço https desta máquina.' };
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    return { ok: false, motivo: 'Permissão de notificação negada.' };
  }
  const { publicKey } = await api.chavePush();
  if (!publicKey) return { ok: false, motivo: 'Servidor sem chave VAPID configurada.' };

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: chaveParaBytes(publicKey) as BufferSource,
    }));
  await api.inscreverPush(sub.toJSON());
  return { ok: true };
}
