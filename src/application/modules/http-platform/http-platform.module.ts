import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { RadarHttpOptions } from '../../../infra/http/http-contracts.js';
import { createRadarHttpContext } from '../../../infra/http/http-platform.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { IdentityService } from '../../services/identity/identity.service.js';
import { AccountContextRepository } from '../../../infra/database/repositories/account-context.repository.js';
import { AccountContextService } from '../../services/accounts/account-context.service.js';

export const RADAR_HTTP_CONTEXT = Symbol('RADAR_HTTP_CONTEXT');

@Global()
@Module({})
export class HttpPlatformModule {
  static forRoot(options: RadarHttpOptions): DynamicModule {
    const context = createRadarHttpContext(options);
    return {
      module: HttpPlatformModule,
      global: true,
      providers: [
        { provide: RADAR_HTTP_CONTEXT, useValue: context }, { provide: RadarHttpContext, useValue: context },
        { provide: IdentityService, inject: [RadarHttpContext], useFactory: (http: RadarHttpContext) => http.identity },
        { provide: AccountContextRepository, inject: [RadarHttpContext], useFactory: (http: RadarHttpContext) => new AccountContextRepository(http.data.query) },
        { provide: AccountContextService, inject: [AccountContextRepository], useFactory: (repository: AccountContextRepository) => new AccountContextService(repository) },
      ],
      exports: [RADAR_HTTP_CONTEXT, RadarHttpContext, IdentityService, AccountContextRepository, AccountContextService],
    };
  }
}
