import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry } from '../../src/core/db/connect-with-retry';

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error('database connection failed'), { code });
}

describe('connectWithRetry', () => {
  it('retries transient connection errors and returns the connected resource', async () => {
    const connection = { connected: true };
    const connect = vi
      .fn<() => Promise<typeof connection>>()
      .mockRejectedValueOnce(codedError('ECONNREFUSED'))
      .mockResolvedValueOnce(connection);
    const wait = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await expect(connectWithRetry(connect, { wait, onRetry })).resolves.toBe(connection);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(onRetry).toHaveBeenCalledWith(1, 'ECONNREFUSED');
  });

  it('does not retry authentication or other permanent errors', async () => {
    const error = codedError('28P01');
    const connect = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const wait = vi.fn(async () => undefined);

    await expect(connectWithRetry(connect, { wait })).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops after the configured number of attempts', async () => {
    const error = codedError('57P03');
    const connect = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const wait = vi.fn(async () => undefined);

    await expect(connectWithRetry(connect, { attempts: 3, wait })).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
