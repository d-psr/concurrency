import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

export interface ResponseMeta {
  statusCode: number;
  path: string;
  method: string;
  timestamp: string;
  requestId?: string;
}

export interface SuccessResponse<T = unknown> {
  data: T;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  error: {
    statusCode: number;
    code: string;
    message: unknown;
  };
  meta: ResponseMeta;
}

const STATUS_REASON: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not Implemented',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

export function buildMeta(params: {
  statusCode: number;
  request: Pick<Request, 'url' | 'method'>;
  requestId?: string;
}): ResponseMeta {
  const { statusCode, request, requestId } = params;
  return {
    statusCode,
    path: request.url,
    method: request.method,
    timestamp: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
  };
}

export function buildSuccessResponse<T>(params: {
  data: T;
  statusCode: number;
  request: Pick<Request, 'url' | 'method'>;
  requestId?: string;
}): SuccessResponse<T> {
  return {
    data: params.data,
    meta: buildMeta(params),
  };
}

export function buildErrorEnvelope(params: {
  statusCode: number;
  code?: string;
  message: unknown;
  request: Pick<Request, 'url' | 'method'>;
  requestId?: string;
}): ErrorEnvelope {
  const { statusCode, code, message } = params;
  return {
    error: {
      statusCode,
      code: code ?? STATUS_REASON[statusCode] ?? 'Error',
      message,
    },
    meta: buildMeta(params),
  };
}
