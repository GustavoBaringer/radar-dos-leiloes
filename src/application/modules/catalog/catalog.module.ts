import { Module } from '@nestjs/common';
import { CatalogController } from '../../controllers/catalog/catalog.controller.js';
import { CatalogService } from '../../services/catalog/catalog.service.js';
import { CATALOG_QUERY, CatalogRepository } from '../../../infra/database/repositories/catalog.repository.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';

@Module({
  controllers: [CatalogController],
  providers: [
    CatalogRepository,
    { provide: CATALOG_QUERY, inject: [RadarHttpContext], useFactory: (context: RadarHttpContext) => context.data.query },
    CatalogService,
  ],
})
export class CatalogModule {}
