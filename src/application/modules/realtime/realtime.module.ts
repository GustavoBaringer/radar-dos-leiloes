import { Module } from '@nestjs/common';
import { RealtimeService } from '../../services/realtime/realtime.service.js';

@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
