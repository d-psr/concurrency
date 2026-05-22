import { type DynamicModule, Module } from '@nestjs/common';
import { PRISMA_MODULE_OPTIONS } from './prisma.constants';
import type {
  PrismaModuleAsyncOptions,
  PrismaModuleOptions,
} from './prisma.options';
import { PrismaService } from './prisma.service';

@Module({})
export class PrismaModule {
  static forRoot(options: PrismaModuleOptions): DynamicModule {
    return {
      global: true,
      module: PrismaModule,
      providers: [
        { provide: PRISMA_MODULE_OPTIONS, useValue: options },
        PrismaService,
      ],
      exports: [PrismaService],
    };
  }

  static forRootAsync(options: PrismaModuleAsyncOptions): DynamicModule {
    return {
      global: true,
      module: PrismaModule,
      imports: options.imports,
      providers: [
        {
          provide: PRISMA_MODULE_OPTIONS,
          inject: options.inject,
          useFactory: options.useFactory,
        },
        PrismaService,
      ],
      exports: [PrismaService],
    };
  }
}
