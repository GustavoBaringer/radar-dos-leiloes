import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../../infra/database/database.module.js';
import { DiscoveryHttpAdapter, type DiscoveryHttpPort } from '../../../infra/discovery/discovery.http.js';
import { DiscoveryRepository, type DiscoveryRepositoryPort } from '../../../infra/discovery/discovery.repository.js';
import { DiscoveryService } from '../../services/discovery/discovery.service.js';
import { DISCOVERY_HTTP, DISCOVERY_REPOSITORY } from './discovery.tokens.js';

export interface DiscoveryModuleOptions {
  dependencies?: { repository: DiscoveryRepositoryPort; http: DiscoveryHttpPort };
  database?: boolean;
}

@Module({})
export class DiscoveryModule {
  static forRoot(options: DiscoveryModuleOptions = {}): DynamicModule {
    return {
      module: DiscoveryModule,
      imports: options.dependencies || options.database === false ? [] : [DatabaseModule],
      providers: options.dependencies ? [
        { provide: DISCOVERY_REPOSITORY, useValue: options.dependencies.repository },
        { provide: DISCOVERY_HTTP, useValue: options.dependencies.http },
        DiscoveryService,
      ] : [
        DiscoveryRepository,
        DiscoveryHttpAdapter,
        { provide: DISCOVERY_REPOSITORY, useExisting: DiscoveryRepository },
        { provide: DISCOVERY_HTTP, useExisting: DiscoveryHttpAdapter },
        DiscoveryService,
      ],
      exports: [DiscoveryService],
    };
  }
}
