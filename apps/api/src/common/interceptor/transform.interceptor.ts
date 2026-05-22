import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { Request, Response } from 'express';
import { SuccessResponse, buildSuccessResponse } from '../response/envelope';

@Injectable()
export class TransformInterceptor<T = unknown> implements NestInterceptor<
  T,
  T | SuccessResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<T | SuccessResponse<T>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const request = httpCtx.getRequest<Request>();
    const response = httpCtx.getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        if (shouldBypass(data)) return data;

        return buildSuccessResponse({
          data: (data ?? null) as T,
          statusCode: response.statusCode,
          request,
          requestId: request.id,
        }) as SuccessResponse<T>;
      }),
    );
  }
}

function shouldBypass(data: unknown): boolean {
  if (data instanceof StreamableFile) return true;
  if (isAlreadyEnveloped(data)) return true;
  return false;
}

function isAlreadyEnveloped(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value
  );
}
