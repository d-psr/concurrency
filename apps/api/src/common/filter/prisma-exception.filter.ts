import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { Request, Response } from 'express';
import { buildErrorEnvelope } from '../response/envelope';
import { Prisma } from '@concurrency/database';

interface PrismaErrorMapping {
  status: number;
  message: (exception: Prisma.PrismaClientKnownRequestError) => string;
}

const KNOWN_MAPPINGS: Record<string, PrismaErrorMapping> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    message: (exception) =>
      `Unique constraint failed on: ${extractUniqueTarget(exception)}`,
  },
  P2025: {
    status: HttpStatus.NOT_FOUND,
    message: (exception) => {
      const cause = exception.meta?.cause;
      return typeof cause === 'string' ? cause : 'Record not found';
    },
  },
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter<Prisma.PrismaClientKnownRequestError> {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
  ) {}

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const mapping = KNOWN_MAPPINGS[exception.code];
    const status = mapping?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const message = mapping ? mapping.message(exception) : 'Database error';

    const body = buildErrorEnvelope({
      statusCode: status,
      code: exception.code,
      message,
      request,
      requestId: request.id,
    });

    const logCtx = PrismaExceptionFilter.name;
    const summary = `[${request.id}] PRISMA ${exception.code} ${request.method} ${request.url} → ${status} ${exception.message.split('\n')[0]}`;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(summary, exception.stack, logCtx);
    } else {
      this.logger.warn(summary, logCtx);
    }

    response.status(status).json(body);
  }
}

function extractUniqueTarget(
  exception: Prisma.PrismaClientKnownRequestError,
): string {
  const meta = exception.meta as
    | {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { index?: unknown } };
        };
      }
    | undefined;

  const target = meta?.target;
  if (Array.isArray(target) && target.length > 0) return target.join(', ');
  if (typeof target === 'string' && target.length > 0) return target;

  const index = meta?.driverAdapterError?.cause?.constraint?.index;
  if (typeof index === 'string' && index.length > 0) return index;

  return 'unknown';
}
