/** Compatibilidade para callers antigos; produção resolve DiscoveryService diretamente. */
export {
  host, hostDoEmail, type ResultadoFenaju, type ResultadoSonda, requirePersistedFenaju,
  acumulaSiteFenaju, PLATAFORMAS, conectorDaPlataforma,
} from '../domain/discovery/discovery.js';
export { UPSERT_AUCTIONEER_FENAJU_SQL } from '../infra/discovery/discovery.repository.js';

async function withService<T>(run: (service: import('../application/services/discovery/discovery.service.js').DiscoveryService) => Promise<T>): Promise<T> {
  const { createDiscoveryContext } = await import('../bootstrap/discovery-context.js');
  const context = await createDiscoveryContext();
  try { return await run(context.service); }
  finally { await context.close(); }
}

export const descobrirFenaju = () => withService((service) => service.descobrirFenaju());
export const sondarSites = (limite?: number, concorrencia?: number) => withService((service) => service.sondarSites(limite, concorrencia));
export const sondarDominios = (dominios: string[], concorrencia?: number) => withService((service) => service.sondarDominios(dominios, concorrencia));
export const rodarDescoberta = (qual: 'fenaju' | 'sonda', limite?: number, concorrencia?: number) =>
  withService((service) => service.rodarDescoberta(qual, limite, concorrencia));
