import pino, { type Logger } from 'pino';
import type { LoggerService } from '@nestjs/common';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.DATABASE_URL',
  '*.WORKER_DATABASE_URL',
  '*.MIGRATOR_DATABASE_URL',
  '*.token',
  '*.secret',
  '*.input',
  '*.password',
  '*.password_hash',
  '*.email',
  '*.firstName',
  '*.first_name',
  '*.lastName',
  '*.last_name',
  '*.date_of_birth',
  '*.patientName',
  '*.patient_name',
  '*.notes',
  '*.subjective',
  '*.objective',
  '*.assessment',
  '*.plan',
  '*.patientSummary',
  '*.patient_summary',
  '*.diagnosis',
];

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: process.env.SERVICE_NAME ?? 'clinik-api' },
});

function safeLogMessage(message: unknown): string | undefined {
  return typeof message === 'string' ? message : undefined;
}

export class PinoNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logger.info({ context }, safeLogMessage(message));
  }

  error(message: unknown, _stack?: string, context?: string): void {
    logger.error({ context }, safeLogMessage(message));
  }

  warn(message: unknown, context?: string): void {
    logger.warn({ context }, safeLogMessage(message));
  }

  debug(message: unknown, context?: string): void {
    logger.debug({ context }, safeLogMessage(message));
  }

  verbose(message: unknown, context?: string): void {
    logger.trace({ context }, safeLogMessage(message));
  }

  fatal(message: unknown, context?: string): void {
    logger.fatal({ context }, safeLogMessage(message));
  }
}
