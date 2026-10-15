import { Inject, Injectable } from '@nestjs/common';
import { decideFreio, type Tentativa, type Veredito } from '../../../domain/collection/collection-brake.js';

export const COLLECTION_BRAKE_DEPENDENCIES = Symbol('COLLECTION_BRAKE_DEPENDENCIES');
export interface CollectionBrakeDependencies {
  tentativasRecentes(sourceId: string): Promise<Tentativa[]>;
  fontesComHistorico(): Promise<string[]>;
}

@Injectable()
export class CollectionBrakeService {
  constructor(@Inject(COLLECTION_BRAKE_DEPENDENCIES) private readonly deps: CollectionBrakeDependencies) {}
  async consultaFreio(sourceId: string): Promise<Veredito> {
    return decideFreio(await this.deps.tentativasRecentes(sourceId));
  }
  async fontesFreadas(): Promise<Array<{ sourceId: string; seguidas: number; proxima?: Date }>> {
    const freadas = [];
    for (const sourceId of await this.deps.fontesComHistorico()) {
      const v = await this.consultaFreio(sourceId);
      if (!v.permite) freadas.push({ sourceId, seguidas: v.seguidas, proxima: v.proxima });
    }
    return freadas;
  }
}
