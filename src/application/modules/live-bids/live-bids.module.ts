import { Module, type DynamicModule } from '@nestjs/common';
import { LIVE_BIDS_DEPENDENCIES, LiveBidsService, type LiveBidsDependencies } from '../../services/live-bids/live-bids.service.js';

@Module({})
export class LiveBidsModule {
  static forRoot(dependencies: LiveBidsDependencies): DynamicModule {
    return { module: LiveBidsModule, providers: [{ provide: LIVE_BIDS_DEPENDENCIES, useValue: dependencies }, LiveBidsService], exports: [LiveBidsService] };
  }
}
