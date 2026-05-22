import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  LoggerService,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { Request, Response } from 'express';
import { buildErrorEnvelope } from '../response/envelope';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
  ) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception.getStatus();
    const { message, code } = normalize(exception.getResponse(), exception);

    const body = buildErrorEnvelope({
      statusCode: status,
      code,
      message,
      request,
      requestId: request.id,
    });

    const logCtx = HttpExceptionFilter.name;
    const summary = `[${request.id}] ${request.method} ${request.url} → ${status} ${stringifyMessage(message)}`;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(summary, exception.stack, logCtx);
    } else {
      this.logger.warn(summary, logCtx);
    }

    response.status(status).json(body);
  }
}

function normalize(
  raw: string | object,
  exception: HttpException,
): { message: unknown; code?: string } {
  if (typeof raw === 'string') {
    return { message: raw, code: exception.name };
  }
  const obj = raw as { message?: unknown; error?: string };
  return {
    message: obj.message ?? exception.message,
    code: obj.error,
  };
}

function stringifyMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
