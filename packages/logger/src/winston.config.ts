import { utilities as nestWinstonUtils } from 'nest-winston';
import { format, transports, type LoggerOptions, type Logform } from 'winston';

export interface WinstonOptionsInput {
  isProduction: boolean;
  appName: string;
  level?: string;
}

export function buildDevelopmentConsoleFormat(appName: string): Logform.Format {
  return format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.ms(),
    format.errors({ stack: true }),
    nestWinstonUtils.format.nestLike(appName, {
      colors: true,
      prettyPrint: true,
    }),
  );
}

export function buildProductionConsoleFormat(): Logform.Format {
  return format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json(),
  );
}

export function createWinstonOptions({
  isProduction,
  appName,
  level,
}: WinstonOptionsInput): LoggerOptions {
  return {
    level: level ?? (isProduction ? 'info' : 'debug'),
    transports: [
      new transports.Console({
        handleExceptions: true,
        handleRejections: true,
        format: isProduction
          ? buildProductionConsoleFormat()
          : buildDevelopmentConsoleFormat(appName),
      }),
    ],
  };
}
