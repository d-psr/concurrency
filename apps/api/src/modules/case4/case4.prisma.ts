import {
  Injectable,
  Logger,
  type FactoryProvider,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, PrismaMariaDb } from '@concurrency/database';
import type { Env } from '../../common/config/env.validation';

export const CASE4_POOL_SIZE = 4;
export const CASE4_PRISMA = Symbol('CASE4_PRISMA');

function buildPoolConfig(datasourceUrl: string): Record<string, unknown> {
  const url = new URL(datasourceUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: CASE4_POOL_SIZE,
  };
}

@Injectable()
class Case4PrismaClient
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(Case4PrismaClient.name);

  constructor(datasourceUrl: string) {
    const adapter = new PrismaMariaDb(buildPoolConfig(datasourceUrl) as never);
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `🟢 case4 Prisma connected (connectionLimit=${CASE4_POOL_SIZE}).`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('🔴 case4 Prisma disconnected.');
  }
}

export const case4PrismaProvider: FactoryProvider = {
  provide: CASE4_PRISMA,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new Case4PrismaClient(config.get('DATABASE_URL')),
};

export type Case4Prisma = Case4PrismaClient;
