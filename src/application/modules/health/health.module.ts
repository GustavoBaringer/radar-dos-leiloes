import { Module } from '@nestjs/common';
import { HealthController } from '../../controllers/health/health.controller.js';
import { HealthService } from '../../services/health/health.service.js';

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}
