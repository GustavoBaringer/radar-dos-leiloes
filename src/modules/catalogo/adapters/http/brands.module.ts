import { Module, type DynamicModule } from '@nestjs/common';
import { BrandsController } from './brands.controller.js';
import { BrandsService, CORE_BRANDS_QUERY, type BrandsQuery } from './brands.service.js';

@Module({ controllers: [BrandsController] })
export class BrandsModule {
  /**
   * A consulta central chega por fora (host legado): nada de importar `core/db`
   * dentro do módulo, para o piloto rodar com dependências controladas.
   */
  static forQuery(query: BrandsQuery): DynamicModule {
    return {
      module: BrandsModule,
      providers: [
        { provide: CORE_BRANDS_QUERY, useValue: query },
        {
          provide: BrandsService,
          useFactory: (coreQuery: BrandsQuery) => new BrandsService(coreQuery),
          // Nest resolve a dependência da factory por `inject` (não `deps`).
          inject: [CORE_BRANDS_QUERY],
        },
      ],
    };
  }
}
