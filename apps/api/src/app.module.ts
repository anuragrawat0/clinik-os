import { Module } from '@nestjs/common';
import { loadApiConfig } from './core/config/config';
import { DatabaseModule } from './core/db/database.module';
import { HealthController } from './core/health/health.controller';

const apiConfig = loadApiConfig();

@Module({
  imports: [DatabaseModule.forRuntimeRole(apiConfig.DATABASE_URL, 'clinic_app', 'clinik-api')],
  controllers: [HealthController],
})
export class AppModule {}
