/** Compatibility exports; worker/CLI production paths use LotClosureService. */
export { VENCIDO, TERMINAL } from '../infra/database/queries/lot-status.js';
export { ausenciaLigada, type ResultadoEncerramento } from '../application/services/closure/lot-closure.service.js';

async function withService<T>(run: (service: import('../application/services/closure/lot-closure.service.js').LotClosureService) => Promise<T>): Promise<T> {
  const { createClosureContext } = await import('../bootstrap/closure-context.js');
  const context = await createClosureContext();
  try { return await run(context.service); }
  finally { await context.close(); }
}

export const encerrarLotes = () => withService((service) => service.encerrarLotes());
export const verificarCandidatos = (teto?: number) => withService((service) => service.verificarCandidatos(teto));
