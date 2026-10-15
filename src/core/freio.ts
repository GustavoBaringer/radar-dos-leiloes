import { decideFreio, type Veredito } from '../domain/collection/collection-brake.js';
import { fontesComHistorico, tentativasRecentes } from '../infra/database/repositories/collection-brake.repository.js';
export { decideFreio, FALHAS_PARA_FREAR, DESCANSO_FREIO_H } from '../domain/collection/collection-brake.js';
export type { Tentativa, Veredito } from '../domain/collection/collection-brake.js';

export async function consultaFreio(sourceId: string): Promise<Veredito> {
  return decideFreio(await tentativasRecentes(sourceId));
}

export async function fontesFreadas(): Promise<Array<{ sourceId: string; seguidas: number; proxima?: Date }>> {
  const freadas = [];
  for (const sourceId of await fontesComHistorico()) {
    const v = await consultaFreio(sourceId);
    if (!v.permite) freadas.push({ sourceId, seguidas: v.seguidas, proxima: v.proxima });
  }
  return freadas;
}
