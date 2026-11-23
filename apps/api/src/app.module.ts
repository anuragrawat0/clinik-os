import { Module } from '@nestjs/common';
import { database, identityCore } from './app.wiring';
import { AccessModule } from './core/access/access.module';
import { AuditModule } from './core/audit/audit.module';
import { CoreAuthModule } from './core/auth/auth.module';
import { ClockModule } from './core/clock/clock';
import { HealthController } from './core/health/health.controller';
import { IdentityHttpModule } from './modules/identity/identity-http.module';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module';
import { TenancyModule } from './modules/tenancy';

export { database, identityCore };

@Module({
  imports: [
    database,
    ClockModule,
    AuditModule.register(database),
    identityCore,
    CoreAuthModule.register(identityCore),
    AccessModule,
    IdentityHttpModule,
    TenancyModule,
    PlatformAdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
