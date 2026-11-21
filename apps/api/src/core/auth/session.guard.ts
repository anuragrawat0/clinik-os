import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { SessionService } from '../../modules/identity/core/session.service';
import type { AuthenticatedRequest } from './auth-context';
import { IS_PUBLIC_KEY } from './public.decorator';
import { clearSessionCookie, readSessionCookie } from './session-cookie';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const rawToken = readSessionCookie(request);
    const result = rawToken ? await this.sessions.validate(rawToken) : null;
    if (result?.status === 'valid') {
      request.auth = result.context;
      return true;
    }
    // Only a dead session is cleared. A blocked user's cookie is left alone (D27).
    if (result?.status === 'dead') clearSessionCookie(http.getResponse<Response>());
    throw new UnauthorizedException({ code: 'UNAUTHENTICATED' });
  }
}
