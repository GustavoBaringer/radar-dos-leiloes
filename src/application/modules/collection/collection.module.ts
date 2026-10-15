import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../../infra/database/database.module.js';
import { avaliarAlertas } from '../../../infra/database/repositories/alerts.repository.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { POST_COLLECTION_EVALUATE, PostCollectionService } from '../../services/collection/post-collection.js';
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
      imports: options.dependencies ? [] : [DatabaseModule, NotificationsModule.forRoot()],
      providers: [
        ...(options.dependencies ? [] : [
          { provide: POST_COLLECTION_EVALUATE, useValue: avaliarAlertas },
          PostCollectionService,
        ]),
        {
          provide: COLLECTION_DEPENDENCIES,
          inject: options.dependencies ? [] : [PostCollectionService],
          useFactory: async (postCollection?: PostCollectionService): Promise<CollectionExecutionDependencies> => {
            if (options.dependencies) return { ...options.dependencies, ...options.overrides };
            const [connectors, repo, observers] = await Promise.all([
              import('../../../connectors/index.js'), import('../../../core/repo.js'),
              import('../../services/collection/collection-observer.js'),
            ]);
            return {
              lookupConnector: connectors.getConnector,
              startRun: repo.startRun, finishRun: repo.finishRun, upsertLots: repo.upsertLots,
              observerForCollection: observers.observerForCollection,
              processarAposColeta: postCollection!.processarAposColeta.bind(postCollection),
              logError: (message, error) => console.error(message, error),
              ...options.overrides,
            };
          },
        },
        CollectionService,
      ],
      exports: [CollectionService, ...(options.dependencies ? [] : [PostCollectionService])],
    };
  }
}
