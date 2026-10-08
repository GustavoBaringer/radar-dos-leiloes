import { Controller, Get, Inject } from '@nestjs/common';
import type { BrandsResponseDto } from './brands.dto.js';
import { BrandsService } from './brands.service.js';

@Controller('/api/brands')
export class BrandsController {
  // @Inject explícito: o token não depende de emitDecoratorMetadata (tsx/esbuild).
  constructor(@Inject(BrandsService) private readonly service: BrandsService) {}

  @Get()
  list(): Promise<BrandsResponseDto> {
    return this.service.list();
  }
}
