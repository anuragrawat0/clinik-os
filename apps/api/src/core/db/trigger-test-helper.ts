interface DatabaseErrorLike {
  code?: string;
  message?: string;
  cause?: unknown;
}

function databaseError(error: unknown): DatabaseErrorLike | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const candidate = current as DatabaseErrorLike;
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, message: candidate.message };
    }
    current = candidate.cause;
  }
  return undefined;
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
