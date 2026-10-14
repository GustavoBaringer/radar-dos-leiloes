import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { RadarHttpOptions } from '../../../infra/http/http-contracts.js';
import { createRadarHttpContext } from '../../../infra/http/http-platform.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';

export const RADAR_HTTP_CONTEXT = Symbol('RADAR_HTTP_CONTEXT');

@Global()
@Module({})
export class HttpPlatformModule {
  static forRoot(options: RadarHttpOptions): DynamicModule {
    const context = createRadarHttpContext(options);
    return {
      module: HttpPlatformModule,
      global: true,
      providers: [{ provide: RADAR_HTTP_CONTEXT, useValue: context }, { provide: RadarHttpContext, useValue: context }],
      exports: [RADAR_HTTP_CONTEXT, RadarHttpContext],
    };
  }
}
