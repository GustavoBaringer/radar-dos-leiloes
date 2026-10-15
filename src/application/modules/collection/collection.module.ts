import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../../infra/database/database.module.js';
import { COLLECTION_DEPENDENCIES, CollectionService, type CollectionExecutionDependencies } from '../../services/collection/collection.service.js';

export interface CollectionModuleOptions {
  /** Complete I/O substitute for isolated tests; does not initialize a database. */
  dependencies?: CollectionExecutionDependencies;
  overrides?: Partial<CollectionExecutionDependencies>;
}

@Module({})
export class CollectionModule {
  static forRoot(options: CollectionModuleOptions = {}): DynamicModule {
    return {
      module: CollectionModule,
      imports: options.dependencies ? [] : [DatabaseModule],
      providers: [
        {
          provide: COLLECTION_DEPENDENCIES,
          useFactory: async (): Promise<CollectionExecutionDependencies> => {
            if (options.dependencies) return { ...options.dependencies, ...options.overrides };
            const [connectors, repo, observers, notifications] = await Promise.all([
              import('../../../connectors/index.js'), import('../../../core/repo.js'),
              import('../../services/collection/collection-observer.js'), import('../../services/collection/post-collection.js'),
            ]);
            return {
              lookupConnector: connectors.getConnector,
              startRun: repo.startRun, finishRun: repo.finishRun, upsertLots: repo.upsertLots,
              observerForCollection: observers.observerForCollection,
              processarAposColeta: notifications.processarAposColeta,
              logError: (message, error) => console.error(message, error),
              ...options.overrides,
            };
          },
        },
        CollectionService,
      ],
      exports: [CollectionService],
    };
  }
}
