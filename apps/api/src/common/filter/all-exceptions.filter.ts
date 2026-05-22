import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { Request, Response } from 'express';
import { Env, NodeEnv } from '../config/env.validation';
import { buildErrorEnvelope } from '../response/envelope';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly isProduction: boolean;

  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
    config: ConfigService<Env, true>,
  ) {
    this.isProduction = config.get('NODE_ENV') === NodeEnv.Production;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const clientMessage = this.isProduction
      ? 'Internal server error'
      : extractDevMessage(exception);

    const body = buildErrorEnvelope({
      statusCode: status,
      message: clientMessage,
      request,
      requestId: request.id,
    });

    const logCtx = AllExceptionsFilter.name;
    const summary = `[${request.id}] UNHANDLED ${request.method} ${request.url} → ${status}`;
    const stack =
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : safeStringify(exception);

    this.logger.error(summary, stack, logCtx);

    response.status(status).json(body);
  }
}

function extractDevMessage(exception: unknown): string {
  if (exception instanceof Error) return exception.message;
  if (typeof exception === 'string') return exception;
  return safeStringify(exception);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
