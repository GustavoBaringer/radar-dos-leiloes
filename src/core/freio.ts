import { CollectionBrakeService } from '../application/services/collection/collection-brake.service.js';
import { fontesComHistorico, tentativasRecentes } from '../infra/database/repositories/collection-brake.repository.js';
export { decideFreio, FALHAS_PARA_FREAR, DESCANSO_FREIO_H } from '../domain/collection/collection-brake.js';
export type { Tentativa, Veredito } from '../domain/collection/collection-brake.js';

const service = new CollectionBrakeService({ fontesComHistorico, tentativasRecentes });
export const consultaFreio = service.consultaFreio.bind(service);
export const fontesFreadas = service.fontesFreadas.bind(service);
