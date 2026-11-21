import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';

/**
 * Registers the global guards. Order matters: CSRF first (cheap, no DB), then session.
 * `identityCore` is the IdentityCoreModule.register(...) object, which exports SessionService.
 */
@Module({})
export class CoreAuthModule {
  static register(identityCore: DynamicModule): DynamicModule {
    return {
      module: CoreAuthModule,
      imports: [identityCore],
      providers: [
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
    };
  }
}
