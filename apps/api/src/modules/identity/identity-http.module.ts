import { Module } from '@nestjs/common';
import { database, identityCore } from '../../app.wiring';
import { AuthMailModule } from '../notifications/auth-mail.module';
import { AuthController } from './auth.controller';
import { AuthProfileService } from './auth-profile.service';

@Module({
  imports: [database, identityCore, AuthMailModule],
  controllers: [AuthController],
  providers: [AuthProfileService],
})
export class IdentityHttpModule {}
