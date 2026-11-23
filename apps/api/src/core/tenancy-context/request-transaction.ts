import type { RoleScope, StaffRole } from '@clinik/shared';
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  createParamDecorator,
} from '@nestjs/common';
import type { Response } from 'express';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth-context';
import type { TenantTransaction } from '../db/transaction-context';

export interface RequestTenant {
  orgId: string;
  roles: (RoleScope & { role: StaffRole })[];
}

export type TenantRequest = AuthenticatedRequest & {
  tenant?: RequestTenant;
  tenantOperation?: TenantOperation;
  tenantWork?: TenantWork;
};

export interface TenantOperation extends RequestTenant {
  tx: TenantTransaction;
  userId: string;
  afterCommit(callback: () => Promise<void>): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// Nest runs guards outside interceptors. The transaction starts during tenant resolution
// and stays open until the interceptor hands it the handler's result or error.
export class TenantWork {
  private readonly handler = deferred<() => Promise<unknown>>();
  private readonly callbacks: (() => Promise<void>)[] = [];
  private readonly completion: Promise<unknown>;
  readonly operation: Promise<TenantOperation>;

  constructor(
    res: Response,
    run: (
      publish: (op: Omit<TenantOperation, 'afterCommit'>) => Promise<unknown>,
    ) => Promise<unknown>,
  ) {
    const operation = deferred<TenantOperation>();
    this.operation = operation.promise;
    const abort = () =>
      this.handler.resolve(async () => {
        throw new HttpException({ code: 'REQUEST_CLOSED' }, 400);
      });
    res.once('close', abort);
    this.completion = run(async (op) => {
      operation.resolve({ ...op, afterCommit: (callback) => this.callbacks.push(callback) });
      if (res.destroyed) abort();
      const handle = await this.handler.promise;
      return handle();
    })
      .catch((error: unknown) => {
        operation.reject(error);
        throw error;
      })
      .finally(() => res.off('close', abort));
    // Authorization may fail before Nest reaches the interceptor, or the client may disconnect.
    void this.completion.catch(() => undefined);
  }

  async finish(handle: () => Promise<unknown>): Promise<unknown> {
    this.handler.resolve(handle);
    const result = await this.completion;
    for (const callback of this.callbacks) await callback();
    return result;
  }
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantOperation => {
    const operation = context.switchToHttp().getRequest<TenantRequest>().tenantOperation;
    if (!operation) throw new Error('CurrentTenant requires a tenant route.');
    return operation;
  },
);

@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const work = context.switchToHttp().getRequest<TenantRequest>().tenantWork;
    return work ? defer(() => work.finish(() => lastValueFrom(next.handle()))) : next.handle();
  }
}
