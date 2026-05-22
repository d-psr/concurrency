import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common/interfaces';
import { WinstonModule } from 'nest-winston';
import {
  createWinstonOptions,
  type WinstonOptionsInput,
} from './winston.config';

export type LoggerModuleOptions = WinstonOptionsInput;

export interface LoggerModuleAsyncOptions extends Pick<
  ModuleMetadata,
  'imports'
> {
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: never[]
  ) => LoggerModuleOptions | Promise<LoggerModuleOptions>;
}

@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions): DynamicModule {
    return {
      module: LoggerModule,
      imports: [WinstonModule.forRoot(createWinstonOptions(options))],
      exports: [WinstonModule],
    };
  }

  static forRootAsync(options: LoggerModuleAsyncOptions): DynamicModule {
    return {
      module: LoggerModule,
      imports: [
        WinstonModule.forRootAsync({
          imports: options.imports,
          inject: options.inject,
          useFactory: async (...args: never[]) => {
            const opts = await options.useFactory(...args);
            return createWinstonOptions(opts);
          },
        }),
      ],
      exports: [WinstonModule],
    };
  }
}
