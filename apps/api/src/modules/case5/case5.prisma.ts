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

export const CASE5_POOL_SIZE = 4;
export const CASE5_PRISMA = Symbol('CASE5_PRISMA');

function buildPoolConfig(datasourceUrl: string): Record<string, unknown> {
  const url = new URL(datasourceUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: CASE5_POOL_SIZE,
  };
}

@Injectable()
class Case5PrismaClient
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(Case5PrismaClient.name);

  constructor(datasourceUrl: string) {
    const adapter = new PrismaMariaDb(buildPoolConfig(datasourceUrl) as never);
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `🟢 case5 Prisma connected (connectionLimit=${CASE5_POOL_SIZE}).`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('🔴 case5 Prisma disconnected.');
  }
}

export const case5PrismaProvider: FactoryProvider = {
  provide: CASE5_PRISMA,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new Case5PrismaClient(config.get('DATABASE_URL')),
};

export type Case5Prisma = Case5PrismaClient;
