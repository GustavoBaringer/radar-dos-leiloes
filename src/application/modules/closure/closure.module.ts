import { Module, type DynamicModule } from '@nestjs/common';
import { DatabaseModule } from '../../../infra/database/database.module.js';
import { LotClosureRepository, type LotClosureRepositoryPort } from '../../../infra/database/repositories/lot-closure.repository.js';
import { VERIFICADORES } from '../../../infra/verification/verifiers.js';
import type { Verificador } from '../../../domain/lots/verification.js';
import { LotClosureService } from '../../services/closure/lot-closure.service.js';
import { LOT_CLOSURE_REPOSITORY, LOT_VERIFIERS } from './closure.tokens.js';

export interface ClosureModuleOptions {
  dependencies?: { repository: LotClosureRepositoryPort; verifiers: Record<string, Verificador> };
  database?: boolean;
}

@Module({})
export class ClosureModule {
  static forRoot(options: ClosureModuleOptions = {}): DynamicModule {
    return {
      module: ClosureModule,
      imports: options.dependencies || options.database === false ? [] : [DatabaseModule],
      providers: options.dependencies ? [
        { provide: LOT_CLOSURE_REPOSITORY, useValue: options.dependencies.repository },
        { provide: LOT_VERIFIERS, useValue: options.dependencies.verifiers },
        LotClosureService,
      ] : [
        LotClosureRepository,
        { provide: LOT_CLOSURE_REPOSITORY, useExisting: LotClosureRepository },
        { provide: LOT_VERIFIERS, useValue: VERIFICADORES },
        LotClosureService,
      ],
      exports: [LotClosureService],
    };
  }
}
