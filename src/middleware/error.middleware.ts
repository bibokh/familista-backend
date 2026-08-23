import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { config } from '../config';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // AppError (operational)
  if (err instanceof AppError) {
    logger.warn('Operational error', {
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    });

    res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
    return;
  }

  // Zod validation error
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // ── the database is not reachable yet, or not reachable any more ────────
  // The HTTP server starts listening before connectDatabase() resolves, so that
  // Render's port scan passes without waiting on the database. On a cold
  // instance that gap is real: Prisma lazy-connects, and a request landing
  // inside it throws an initialization or pool error. Falling through to the
  // catch-all made that an HTTP 500 on the login screen — which says the server
  // is broken, when what is true is that it is not ready yet.
  //
  // 503 with Retry-After is what that condition is. It is not a retry bolted on
  // to hide a fault: it is the status the fault actually has, and it lets a
  // client and a load balancer behave correctly instead of treating a cold
  // start as a crash.
  const NOT_READY = new Set([
    'P1000', // authentication failed against the database
    'P1001', // can't reach database server
    'P1002', // database server reached but timed out
    'P1008', // operation timed out
    'P1017', // server has closed the connection
    'P2024', // timed out fetching a connection from the pool
  ]);
  const prismaCode = (err as unknown as { code?: string }).code;
  const notReady =
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && NOT_READY.has(err.code)) ||
    (typeof prismaCode === 'string' && NOT_READY.has(prismaCode));

  if (notReady) {
    logger.warn('Database not reachable — answering 503', {
      code: prismaCode,
      name: err.constructor.name,
      path: req.path,
      method: req.method,
    });
    res
      .status(503)
      .header('Retry-After', '2')
      .header('X-Error-Type', err.constructor.name)
      .header('X-Error-Code', prismaCode ?? '')
      .json({
        success: false,
        message: 'The service is starting up — please try again in a moment',
      });
    return;
  }

  // Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        success: false,
        message: 'A record with this value already exists',
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        message: 'Record not found',
      });
      return;
    }
  }

  // Unknown / programming errors
  // NOTE: req.body is intentionally omitted — it can contain plaintext passwords
  // (e.g. a failed login when the DB is down) and must never reach the log sink.
  const errCode = prismaCode;
  logger.error('Unexpected error', {
    message: err.message,
    code:    errCode,
    name:    err.constructor.name,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Non-sensitive debug headers: error class name + Prisma P-code (if any).
  // Allows diagnosing 500s from HTTP response headers without needing log access.
  res
    .status(500)
    .header('X-Error-Type', err.constructor.name)
    .header('X-Error-Code', errCode ?? '')
    .json({
      success: false,
      message: config.isProd ? 'Internal server error' : err.message,
      ...(config.isDev && { stack: err.stack }),
    });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
}
