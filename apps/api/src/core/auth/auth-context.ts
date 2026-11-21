import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionContext } from '../../modules/identity/core/types';

/** Express request as seen after SessionGuard. `auth` is set on every non-`@Public` route. */
export type AuthenticatedRequest = Request & { auth?: SessionContext };

/** The authenticated session of the current request. Only valid on non-`@Public` routes. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route without SessionGuard.');
  return auth;
});
