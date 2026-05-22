import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  LoggerService,
  NestInterceptor,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const request = httpCtx.getRequest<Request>();
    const response = httpCtx.getResponse<Response>();

    const { method, url, id } = request;
    const startedAt = Date.now();

    const ctx = LoggingInterceptor.name;
    this.logger.verbose?.(`[${id}] → ${method} ${url}`, ctx);

    return next.handle().pipe(
      tap({
        next: () => {
          const elapsedMs = Date.now() - startedAt;
          this.logger.log(
            `[${id}] ← ${method} ${url} ${response.statusCode} ${elapsedMs}ms`,
            ctx,
          );
        },
      }),
    );
  }
}
