import { Global, Module } from '@nestjs/common';
import { LotsRepository } from './repositories/lots.repository.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: () => PrismaService.getInstance() },
    LotsRepository,
  ],
  exports: [PrismaService, LotsRepository],
})
export class DatabaseModule {}
