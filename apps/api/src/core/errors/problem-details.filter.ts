import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

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
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
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
        : status === 404
          ? 'NOT_FOUND'
          : 'REQUEST_FAILED';
    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance: request.path,
      code,
      ...(request.id ? { requestId: request.id } : {}),
    };

    response.status(status).type('application/problem+json').json(problem);
  }
}
