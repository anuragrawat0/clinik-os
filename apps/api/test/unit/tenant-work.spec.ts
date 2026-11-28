import type { Response } from 'express';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/core/logging/logger';
import { TenantWork } from '../../src/core/tenancy-context/request-transaction';

/**
 * M1 post-audit (B-1). The denial audit and session revocation now run through
 * `afterRollback` because they must not open a second pool connection while the request
 * transaction still holds the first (audit-report.md B-1). These tests pin the hook contract:
 * post-commit hooks run only on commit, post-rollback hooks run only on rollback, and a throwing
 * hook is surfaced instead of being swallowed.
 */
function fakeResponse() {
  return { destroyed: false, once: vi.fn(), off: vi.fn() } as unknown as Response;
}

function operationStub() {
  return { orgId: 'org-1', roles: [], userId: 'user-1', tx: {} as never };
}

describe('TenantWork commit and rollback hooks', () => {
  it('runs afterCommit hooks on commit and never the rollback hooks', async () => {
    const events: string[] = [];
    const work = new TenantWork(fakeResponse(), (publish) => publish(operationStub()));
    const operation = await work.operation;

    const result = await work.finish(async () => {
      operation.afterCommit(async () => {
        events.push('commit');
      });
      operation.afterRollback(async () => {
        events.push('rollback');
      });
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(events).toEqual(['commit']);
  });

  it('runs afterRollback hooks instead of afterCommit when the handler fails', async () => {
    const events: string[] = [];
    const work = new TenantWork(fakeResponse(), (publish) => publish(operationStub()));
    const operation = await work.operation;
    const failure = new HttpException({ code: 'INVALID_PASSWORD' }, 422);

    await expect(
      work.finish(async () => {
        operation.afterCommit(async () => {
          events.push('commit');
        });
        operation.afterRollback(async () => {
          events.push('rollback');
        });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events).toEqual(['rollback']);
  });

  it('surfaces a throwing rollback hook instead of swallowing it', async () => {
    const events: string[] = [];
    const work = new TenantWork(fakeResponse(), (publish) => publish(operationStub()));
    const operation = await work.operation;
    const failure = new HttpException({ code: 'INVALID_PASSWORD' }, 422);
    const hookFailure = new HttpException({ code: 'SERVICE_UNAVAILABLE' }, 503);

    await expect(
      work.finish(async () => {
        operation.afterCommit(async () => {
          events.push('commit');
        });
        operation.afterRollback(async () => {
          events.push('denial');
          throw hookFailure;
        });
        throw failure;
      }),
    ).rejects.toBe(hookFailure);

    expect(events).toEqual(['denial']);
  });

  it.each(['afterCommit', 'afterRollback'] as const)(
    'runs all %s hooks, rethrows the first failure and logs only the later error class',
    async (register) => {
      const work = new TenantWork(fakeResponse(), (publish) => publish(operationStub()));
      const operation = await work.operation;
      const first = new TypeError('Synthetic first hook failure');
      const second = vi.fn(async () => {
        throw new SyntaxError('Synthetic second hook failure');
      });
      const log = vi.spyOn(logger, 'error');
      try {
        await expect(
          work.finish(async () => {
            operation[register](async () => {
              throw first;
            });
            operation[register](second);
            if (register === 'afterRollback') throw new Error('Synthetic transaction failure');
          }),
        ).rejects.toBe(first);
        expect(second).toHaveBeenCalledTimes(1);
        expect(log.mock.calls).toEqual([
          [{ errorClass: 'SyntaxError' }, 'Tenant transaction hook failed'],
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );
});
