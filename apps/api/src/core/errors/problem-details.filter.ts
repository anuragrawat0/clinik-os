import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { logger } from '../logging/logger';
import { errorClass, errorCode, errorConstraint } from '../logging/startup-failure';

export function setApiCachePolicy(path: string, response: Response): void {
  if (/^\/api\/v1(?:\/|$)/i.test(path) && !/^\/api\/v1\/health\/?$/i.test(path))
    response.setHeader('Cache-Control', 'no-store');
}

const pgPoolTimeoutMessages = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'timeout expired',
]);

interface ProblemDetails {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId?: string;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const requestPath = (request.originalUrl ?? request.path).split(/[?#]/)[0];
    const invitationPath = /^\/api\/v1\/auth\/invitations(?:\/|$)/i.test(requestPath);
    const cause = exception instanceof HttpException ? (exception.cause ?? exception) : exception;
    const error = cause instanceof DrizzleQueryError ? (cause.cause ?? cause) : cause;
    const poolTimedOut = error instanceof Error && pgPoolTimeoutMessages.has(error.message);
    const status =
      invitationPath &&
      (exception instanceof URIError ||
        (exception instanceof HttpException && exception.cause instanceof URIError))
        ? HttpStatus.NOT_FOUND
        : exception instanceof HttpException
          ? exception.getStatus()
          : poolTimedOut
            ? HttpStatus.SERVICE_UNAVAILABLE
            : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionBody = exception instanceof HttpException ? exception.getResponse() : undefined;
    const body =
      typeof exceptionBody === 'object' && exceptionBody !== null ? exceptionBody : undefined;
    const title = HttpStatus[status] ?? 'Error';
    const detail =
      status >= 500 ? 'An unexpected error occurred.' : 'The request could not be completed.';
    const codeCandidate = body && 'code' in body ? body.code : undefined;
    const code =
      typeof codeCandidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(codeCandidate)
        ? codeCandidate
        : status === HttpStatus.SERVICE_UNAVAILABLE
          ? 'SERVICE_UNAVAILABLE'
          : status === HttpStatus.NOT_FOUND
            ? 'NOT_FOUND'
            : 'REQUEST_FAILED';
    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      // Invitation URLs carry a credential, including when a path parameter fails to decode.
      instance: invitationPath ? '/api/v1/auth/invitations' : requestPath,
      code,
      ...(request.id ? { requestId: request.id } : {}),
    };

    if (status >= 500) {
      logger.error(
        {
          requestId: request.id,
          errorClass: errorClass(error),
          code: errorCode(error) ?? (poolTimedOut ? 'ETIMEDOUT' : undefined),
          constraint: errorConstraint(error),
        },
        'HTTP request failed',
      );
    }
    setApiCachePolicy(requestPath, response);
    response.status(status).type('application/problem+json').json(problem);
  }
}
