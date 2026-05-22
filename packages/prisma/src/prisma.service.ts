import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/client/client';
import { PRISMA_MODULE_OPTIONS } from './prisma.constants';
import type { PrismaModuleOptions } from './prisma.options';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(PRISMA_MODULE_OPTIONS) options: PrismaModuleOptions) {
    const adapter = new PrismaMariaDb(options.datasourceUrl);
    super({ adapter, log: options.log });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('🟢 Prisma connected.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('🔴 Prisma disconnected.');
  }
}
