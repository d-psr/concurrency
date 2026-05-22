import type { ModuleMetadata } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common/interfaces';

export interface PrismaModuleOptions {
  datasourceUrl: string;
  log?: ('query' | 'info' | 'warn' | 'error')[];
}

export interface PrismaModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: never[]
  ) => PrismaModuleOptions | Promise<PrismaModuleOptions>;
}
