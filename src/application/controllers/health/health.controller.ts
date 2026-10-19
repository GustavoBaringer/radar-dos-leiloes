import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthDto, HealthQueryDto } from './health.dto.js';
import { HealthService } from '../../services/health/health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOkResponse({ type: HealthDto })
  check(@Query() _query: HealthQueryDto): HealthDto {
    return this.health.check();
  }
}
