import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

const HEADER_NAME = 'x-request-id';

const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER_NAME);
    const id = isAcceptable(incoming) ? incoming : randomUUID();

    req.id = id;
    res.setHeader(HEADER_NAME, id);

    next();
  }
}

function isAcceptable(value: string | undefined): value is string {
  return typeof value === 'string' && VALID_ID.test(value);
}
