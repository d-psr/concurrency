import type { ModuleMetadata } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common/interfaces';
import type { RedisOptions } from 'ioredis';

export interface RedisModuleOptions {
  url: string;
  options?: RedisOptions;
}

export interface RedisModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: never[]
  ) => RedisModuleOptions | Promise<RedisModuleOptions>;
}
