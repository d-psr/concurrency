import { type DynamicModule, Module } from '@nestjs/common';
import { REDIS_MODULE_OPTIONS } from './redis.constants';
import type {
  RedisModuleAsyncOptions,
  RedisModuleOptions,
} from './redis.options';
import { RedisService } from './redis.service';

@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      global: true,
      module: RedisModule,
      providers: [
        { provide: REDIS_MODULE_OPTIONS, useValue: options },
        RedisService,
      ],
      exports: [RedisService],
    };
  }

  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    return {
      global: true,
      module: RedisModule,
      imports: options.imports,
      providers: [
        {
          provide: REDIS_MODULE_OPTIONS,
          inject: options.inject,
          useFactory: options.useFactory,
        },
        RedisService,
      ],
      exports: [RedisService],
    };
  }
}
