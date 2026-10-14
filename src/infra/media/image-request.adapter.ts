import type { FastifyReply, FastifyRequest } from 'fastify';

/** Tie an upstream abort signal to the caller's raw socket lifecycle. */
export function imageRequestSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const onAborted = () => controller.abort();
  const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
  request.raw.once('aborted', onAborted);
  reply.raw.once('close', onClose);
  return {
    signal: controller.signal,
    close() {
      request.raw.off('aborted', onAborted);
      reply.raw.off('close', onClose);
    },
  };
}
