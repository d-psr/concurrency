import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_MODULE_OPTIONS } from './redis.constants';
import type { RedisModuleOptions } from './redis.options';

@Injectable()
export class RedisService
  extends Redis
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_MODULE_OPTIONS) options: RedisModuleOptions) {
    super(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      ...options.options,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
    this.logger.log('🟢 Redis connected.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
    this.logger.log('🔴 Redis disconnected.');
  }
}
