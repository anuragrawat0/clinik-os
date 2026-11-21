import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site forms cannot set custom headers, so requiring one on every state-changing request
 * complements SameSite=Lax. Applies to @Public routes too (login is public but state-changing).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
      throw new ForbiddenException({ code: 'CSRF_REJECTED' });
    }
    return true;
  }
}
