import { Module, type DynamicModule } from '@nestjs/common';
import { tentativasRecentes, fontesComHistorico } from '../../../infra/database/repositories/collection-brake.repository.js';
import { CollectionBrakeService, COLLECTION_BRAKE_DEPENDENCIES, type CollectionBrakeDependencies } from '../../services/collection/collection-brake.service.js';

@Module({})
export class CollectionBrakeModule {
  static forRoot(dependencies: CollectionBrakeDependencies = { tentativasRecentes, fontesComHistorico }): DynamicModule {
    return { module: CollectionBrakeModule, providers: [{ provide: COLLECTION_BRAKE_DEPENDENCIES, useValue: dependencies }, CollectionBrakeService], exports: [CollectionBrakeService] };
  }
}
