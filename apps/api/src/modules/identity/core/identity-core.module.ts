import { DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../../../core/audit/audit.module';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';
import { ClientIpResolver, TRUSTED_PROXY_CIDRS } from './client-ip-resolver';
import { IpRateLimiter } from './ip-rate-limiter';
import { LockoutService } from './lockout.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

export interface IdentityCoreOptions {
  /** The same DynamicModule object the application imports, so the DB pool stays a singleton. */
  database: DynamicModule;
  trustedProxyCidrs: readonly string[];
}

const services = [
  PasswordService,
  TokenService,
  SessionService,
  LockoutService,
  IpRateLimiter,
  ClientIpResolver,
  AuthTokenService,
  AuthService,
];

@Module({})
export class IdentityCoreModule {
  static register(options: IdentityCoreOptions): DynamicModule {
    return {
      module: IdentityCoreModule,
      imports: [options.database, AuditModule.register(options.database)],
      providers: [
        { provide: TRUSTED_PROXY_CIDRS, useValue: [...options.trustedProxyCidrs] },
        ...services,
      ],
      exports: services,
    };
  }
}
