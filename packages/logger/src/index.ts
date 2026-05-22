export {
  createWinstonOptions,
  buildDevelopmentConsoleFormat,
  buildProductionConsoleFormat,
} from './winston.config';
export type { WinstonOptionsInput } from './winston.config';
export { LoggerModule } from './logger.module';
export type {
  LoggerModuleOptions,
  LoggerModuleAsyncOptions,
} from './logger.module';
export { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
