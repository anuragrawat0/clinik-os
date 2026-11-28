import { DatabaseError } from 'pg';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

export type StartupStep =
  | 'config.load'
  | 'nest.create'
  | 'http.configure'
  | 'http.init'
  | 'db.role-self-check.query'
  | 'db.role-self-check.validate'
  | 'http.listen';

export class StartupFailure extends Error {
  constructor(
    readonly step: StartupStep,
    cause: unknown,
  ) {
    super('Startup step failed', { cause });
  }
}

const systemCodes = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export function errorClass(error: unknown): string {
  if (error instanceof DatabaseError) return 'DatabaseError';
  if (error instanceof ZodError) return 'ZodError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  return 'UnknownError';
}

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string')
    return undefined;
  if (error instanceof DatabaseError)
    return /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? error.code : undefined;
}

export function errorConstraint(error: unknown): string | undefined {
  return error instanceof DatabaseError &&
    typeof error.constraint === 'string' &&
    /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(error.constraint)
    ? error.constraint
    : undefined;
}

export function logApiStartupFailure(
  logger: Pick<Logger, 'fatal'>,
  step: StartupStep,
  failure: unknown,
): void {
  const error = failure instanceof StartupFailure ? failure.cause : failure;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const connectionClosed =
    error instanceof Error && error.message === 'Connection terminated unexpectedly';

  logger.fatal(
    {
      step: failure instanceof StartupFailure ? failure.step : step,
      errorClass: errorClass(error),
      code:
        error instanceof DatabaseError && typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)
          ? code
          : null,
      ...(typeof code === 'string' && systemCodes.has(code) ? { systemCode: code } : {}),
      ...(connectionClosed ? { reason: 'database-connection-closed' } : {}),
    },
    'API startup failed',
  );
}
