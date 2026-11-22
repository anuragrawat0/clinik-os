import { Module } from '@nestjs/common';
import { database, identityCore } from '../../app.wiring';
import { AuditModule } from '../../core/audit';
import { InvitationController } from './invitation.controller';
import { InvitationService } from './invitation.service';

@Module({
  imports: [database, identityCore, AuditModule.register(database)],
  controllers: [InvitationController],
  providers: [InvitationService],
})
export class InvitationModule {}
