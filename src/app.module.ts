import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from './application/modules/health/health.module.js';
import type { RadarHttpOptions } from './infra/http/http-contracts.js';
import { HttpPlatformModule } from './application/modules/http-platform/http-platform.module.js';
import { AuthModule } from './application/modules/auth/auth.module.js';
import { AccountsModule } from './application/modules/accounts/accounts.module.js';
import { CatalogModule } from './application/modules/catalog/catalog.module.js';
import { PagesModule } from './application/modules/pages/pages.module.js';
import { PlatformModule } from './application/modules/platform/platform.module.js';
import { MediaModule } from './application/modules/media/media.module.js';
import { RealtimeModule } from './application/modules/realtime/realtime.module.js';
import { BillingModule } from './application/modules/billing/billing.module.js';

@Module({ imports: [HealthModule] })
export class AppModule {
  static forRoot(options: RadarHttpOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HttpPlatformModule.forRoot(options), AuthModule, AccountsModule, CatalogModule,
        PagesModule, PlatformModule, MediaModule.forRoot(), RealtimeModule, BillingModule,
      ],
    };
  }
}
