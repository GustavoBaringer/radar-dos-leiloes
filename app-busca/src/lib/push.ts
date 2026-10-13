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
 * Registro e inscrição saem daqui para os dois caminhos compartilharem o mesmo
 * reparo: ativar do zero e reconciliar o que já estava autorizado.
 */
async function registrarServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}

/** Sem inscrição no navegador, recria com a chave pública que o servidor publica. */
async function assinarComChaveDoServidor(reg: ServiceWorkerRegistration, chaveJaConhecida?: string | null): Promise<PushSubscription | null> {
  const chave = chaveJaConhecida === undefined ? (await api.chavePush()).publicKey : chaveJaConhecida;
  if (!chave) return null;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: chaveParaBytes(chave) as BufferSource,
  });
}

/**
 * Reconcilia a inscrição já autorizada pelo usuário, sem pedir permissão.
 *
 * Antes disto só reenviava ao servidor a inscrição que já existia no navegador.
 * Se o service worker ou a inscrição sumissem — storage do site limpo no
 * Android, site removido dos dados, navegador em outro perfil — o servidor
 * continuava guardando a inscrição velha, o serviço de push continuava aceitando
 * o envio com 201 e a notificação nunca aparecia: alerta marcava "entregue" e o
 * usuário não recebia nada, sem erro em lugar nenhum. Registrar e reassinar
 * quando falta conserta essa divergência sozinha.
 *
 * Todo caminho que falha devolve `motivo`: sem ele a tela não mostrava nada e o
 * silêncio era indistinguível de "está tudo certo".
 */
export async function sincronizarPushAutorizado(): Promise<{ ok: boolean; motivo?: string }> {
  if (typeof Notification === 'undefined') return { ok: false, motivo: 'Notificação push não existe neste navegador.' };
  if (Notification.permission === 'denied') {
    return { ok: false, motivo: 'Permissão de notificação negada. Libere nas permissões do site e recarregue.' };
  }
  if (Notification.permission !== 'granted') {
    return { ok: false, motivo: 'Permissão de notificação ainda não foi concedida.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) {
    return { ok: false, motivo: 'Este navegador não permite sincronizar notificações push.' };
  }

  const reg = await navigator.serviceWorker.getRegistration() ?? await registrarServiceWorker();
  const sub = await reg.pushManager.getSubscription() ?? await assinarComChaveDoServidor(reg);
  if (!sub) return { ok: false, motivo: 'O navegador não devolveu inscrição de push.' };
  await api.inscreverPush(sub.toJSON());
  return { ok: true };
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

  const reg = await registrarServiceWorker();
  const sub = await reg.pushManager.getSubscription() ?? await assinarComChaveDoServidor(reg, publicKey);
  if (!sub) return { ok: false, motivo: 'O navegador não aceitou a inscrição de push.' };
  await api.inscreverPush(sub.toJSON());
  return { ok: true };
}
