import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const requestIdPattern = /^[A-Za-z0-9._-]{8,128}$/;

export function createRequestId(request: IncomingMessage, response: ServerResponse): string {
  const candidate = request.headers['x-request-id'];
  const requestId =
    typeof candidate === 'string' && requestIdPattern.test(candidate) ? candidate : randomUUID();
  response.setHeader('x-request-id', requestId);
  return requestId;
}
