import { Module } from '@nestjs/common';
import { database, identityCore } from './app.wiring';
import { AuditModule } from './core/audit/audit.module';
import { CoreAuthModule } from './core/auth/auth.module';
import { ClockModule } from './core/clock/clock';
import { HealthController } from './core/health/health.controller';

export { database, identityCore };

@Module({
  imports: [
    database,
    ClockModule,
    AuditModule.register(database),
    identityCore,
    CoreAuthModule.register(identityCore),
  ],
  controllers: [HealthController],
})
export class AppModule {}
