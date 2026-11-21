import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Exempts a route (or controller) from SessionGuard. CsrfGuard still applies. Every public route
 * must also be listed in the allow-list of test/http/route-coverage.e2e.spec.ts.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
