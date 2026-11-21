import type { Request, Response } from 'express';
import { SESSION_ABSOLUTE_TIMEOUT_MS } from '../../modules/identity/core/identity.constants';

/** `__Host-` forces Secure, Path=/ and no Domain in the browser. */
export const SESSION_COOKIE_NAME = '__Host-session';

const baseOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

export function setSessionCookie(response: Response, rawToken: string): void {
  response.cookie(SESSION_COOKIE_NAME, rawToken, {
    ...baseOptions,
    maxAge: SESSION_ABSOLUTE_TIMEOUT_MS,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, baseOptions);
}

/** Minimal Cookie header parser; the first occurrence of the session cookie wins. */
export function readSessionCookie(request: Pick<Request, 'headers'>): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
