import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'auth:skipCsrf';

/**
 * ONLY for the Stripe webhook (M5), which is authenticated by its signature and is never called by
 * a browser. Do not use it on any other route.
 */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF_KEY, true);
