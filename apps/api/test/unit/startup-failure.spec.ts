import { DatabaseError } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../../src/core/db/database.module';
import { logApiStartupFailure } from '../../src/core/logging/startup-failure';

describe('API startup failure logging', () => {
  it('logs a PostgreSQL role check failure using only a safe step, class and SQLSTATE', async () => {
    const password = 'synthetic-password';
    const connectionString = `postgresql://clinic_app:${password}@127.0.0.1:1/test`;
    const queryParameter = 'synthetic-private-query-parameter';
    const pgError = new DatabaseError(`Failed on ${connectionString}`, 0, 'error');
    pgError.code = '28P01';
    pgError.detail = password;
    pgError.where = queryParameter;
    const fatal = vi.fn();
    const connection = new DatabaseConnection(connectionString, 'clinic_app', 'startup-test');
    vi.spyOn(connection.pool, 'query').mockRejectedValue(pgError);
    try {
      await expect(connection.onModuleInit()).rejects.toMatchObject({
        step: 'db.role-self-check.query',
        cause: pgError,
      });
      await connection.onModuleInit().catch((error: unknown) => {
        logApiStartupFailure({ fatal }, 'http.init', error);
      });
    } finally {
      await connection.onModuleDestroy();
    }

    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      { step: 'db.role-self-check.query', errorClass: 'DatabaseError', code: '28P01' },
      'API startup failed',
    );
    const output = JSON.stringify(fatal.mock.calls);
    for (const secret of [connectionString, password, queryParameter]) {
      expect(output).not.toContain(secret);
    }
  });

  it('reports a closed connection without inventing a SQLSTATE', () => {
    const fatal = vi.fn();
    logApiStartupFailure({ fatal }, 'http.init', new Error('Connection terminated unexpectedly'));
    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      { step: 'http.init', errorClass: 'Error', code: null, reason: 'database-connection-closed' },
      'API startup failed',
    );
  });

  it('distinguishes an HTTP port conflict from a database error', () => {
    const fatal = vi.fn();
    const error = Object.assign(new Error('private bind details'), { code: 'EADDRINUSE' });
    logApiStartupFailure({ fatal }, 'http.listen', error);
    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      { step: 'http.listen', errorClass: 'Error', code: null, systemCode: 'EADDRINUSE' },
      'API startup failed',
    );
  });
});
