const retryableDatabaseCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ETIMEDOUT',
  '57P03',
]);

export interface ConnectRetryOptions {
  attempts?: number;
  delayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  onRetry?: (attempt: number, code: string) => void;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  options: ConnectRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 1_000;
  const wait = options.wait ?? delay;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      const code = getErrorCode(error);
      if (!code || !retryableDatabaseCodes.has(code) || attempt === attempts) throw error;
      options.onRetry?.(attempt, code);
      await wait(delayMs);
    }
  }

  throw new Error('PostgreSQL connection retry attempts were exhausted.');
}
