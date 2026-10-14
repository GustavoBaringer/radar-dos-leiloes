import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for Prisma');
    super({ adapter: new PrismaPg({ connectionString: url }) });
    PrismaService.instance = this;
  }

  private static instance: PrismaService | undefined;

  static getInstance(): PrismaService {
    if (!this.instance) this.instance = new PrismaService();
    return this.instance;
  }

  static async disconnectInstance(): Promise<void> {
    if (this.instance) await this.instance.onModuleDestroy();
  }

  async onModuleInit(): Promise<void> { await this.$connect(); }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    if (PrismaService.instance === this) PrismaService.instance = undefined;
  }
}
