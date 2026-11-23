import { Module } from '@nestjs/common';
import { database, identityCore } from '../../app.wiring';
import { AuditModule } from '../../core/audit';
import { AuthMailModule } from '../notifications/auth-mail.module';
import { InvitationController } from './invitation.controller';
import { InvitationService } from './invitation.service';
import { MemberService } from './member.service';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  imports: [database, identityCore, AuditModule.register(database), AuthMailModule],
  controllers: [InvitationController, OrganizationController],
  providers: [InvitationService, MemberService, OrganizationService],
  exports: [InvitationService, OrganizationService],
})
export class TenancyModule {}
