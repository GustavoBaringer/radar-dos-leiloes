import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { radarActorFromRequest, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { CollectionAdminService } from '../../services/platform/collection-admin.service.js';

@Controller()
export class CollectionAdminController {
  constructor(private readonly collection: CollectionAdminService) {}
  @HttpCode(200)
  @Post('/api/collect') enqueue(@Req() request: RadarHttpRequest, @Body() body: unknown) {
    return this.collection.enqueue(radarActorFromRequest(request), body);
  }
}
