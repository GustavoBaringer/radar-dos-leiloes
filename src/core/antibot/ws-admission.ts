import type { WsReservation, WsReserveResult } from './ws.js';

type WsProtection = {
  reserve(accountId: number): Promise<WsReserveResult>;
  release(reservation: WsReservation): Promise<void>;
  attach(reservation: WsReservation, socket: any): void;
};

type AdmissionRequest = {
  ws?: boolean;
  eu?: { userId?: unknown };
  raw: any;
  wsReservation?: WsReservation;
  wsAdmissionCleanup?: () => void;
};
type AdmissionReply = any;

export async function admitWsUpgrade(
  req: AdmissionRequest,
  reply: AdmissionReply,
  options: {
    protection: WsProtection;
    checkAccount: (userId: number) => Promise<any>;
    sendUnauthenticated: (reply: AdmissionReply) => unknown;
    sendRateLimit: (reply: AdmissionReply, decision: any) => boolean;
  },
): Promise<void> {
  // @fastify/websocket marks only internally validated upgrades as req.ws.
  if (!req.ws) return;
  const userId = Number(req.eu?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) { options.sendUnauthenticated(reply); return; }
  const decision = await options.checkAccount(userId);
  if (options.sendRateLimit(reply, decision)) return;
  const reserved = await options.protection.reserve(userId);
  if (!reserved.allowed) {
    const status = reserved.status;
    reply.code(status).header('Cache-Control', 'no-store');
    if (status === 429) reply.header('Retry-After', '60').send({ error: 'rate_limited', retryAfterSeconds: 60 });
    else reply.send({ error: status === 401 ? 'unauthorized' : 'overloaded', retryAfterSeconds: 1 });
    return;
  }
  req.wsReservation = reserved.reservation;
  const cleanup = () => {
    req.raw.off('aborted', onAbort);
    req.raw.off('error', onError);
    reply.raw.off('finish', onFinish);
    reply.raw.off('close', onClose);
  };
  const release = () => { cleanup(); void options.protection.release(reserved.reservation); };
  const onAbort = () => release();
  const onError = () => release();
  const onFinish = () => release();
  const onClose = () => release();
  req.wsAdmissionCleanup = cleanup;
  req.raw.once('aborted', onAbort);
  req.raw.once('error', onError);
  reply.raw.once('finish', onFinish);
  reply.raw.once('close', onClose);
  if (req.raw.aborted || reply.raw.destroyed || reply.raw.writableFinished) release();
}

export function attachWsUpgrade(req: AdmissionRequest, socket: any, protection: WsProtection): boolean {
  const reservation = req.wsReservation;
  if (!reservation) { socket.terminate(); return false; }
  req.wsAdmissionCleanup?.();
  protection.attach(reservation, socket);
  return true;
}
