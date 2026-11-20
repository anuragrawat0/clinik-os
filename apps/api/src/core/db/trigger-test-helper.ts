interface DatabaseErrorLike {
  code?: string;
  message?: string;
}

function databaseError(error: unknown): DatabaseErrorLike | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return error as DatabaseErrorLike;
}

export function assertExpectedSqlState(error: unknown, acceptedCodes: readonly string[]): void {
  const dbError = databaseError(error);
  const code = dbError?.code;

  if (!code) {
    throw new Error('Expected a PostgreSQL error with a SQLSTATE code.');
  }
  if (code.startsWith('42') && code !== '42501') {
    throw new Error(
      `Unexpected PostgreSQL programming error ${code}: ${dbError?.message ?? 'unknown'}`,
    );
  }
  if (!acceptedCodes.includes(code)) {
    throw new Error(
      `Expected SQLSTATE ${acceptedCodes.join(' or ')}, received ${code}: ${dbError?.message ?? 'unknown'}`,
    );
  }
}
