import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { database, identityCore } from '../../app.wiring';
import { PlatformAdmin } from '../../core/access/access';
import { CurrentAuth } from '../../core/auth';
import { DATABASE, DatabaseConnection } from '../../core/db/database.module';
import { withTenantTransaction } from '../../core/db/transaction-context';
import { parseInput } from '../../core/errors/http-validation';
import { ClientIpResolver, requestMetaFrom, type SessionContext } from '../identity/core';
import {
  InvitationService,
  OrganizationService,
  TenancyModule,
  type OrganizationActor,
} from '../tenancy';
import {
  CreateOrganizationDto,
  InvitationDeliveryDto,
  OrganizationDto,
  OrganizationPageDto,
  OwnerInvitationDto,
  ProvisionedOrganizationDto,
  UpdateOrganizationDto,
  createOrganizationInput,
  organizationPageInput,
  ownerInviteInput,
  resourceId,
  updateOrganizationInput,
} from '../tenancy/tenancy.dto';

const organizationParam = () => ApiParam({ name: 'id', type: String, format: 'uuid' });

@ApiTags('platform-admin')
@ApiCookieAuth()
@ApiResponse({ status: 404, description: 'Resource unavailable' })
@PlatformAdmin()
@Controller('admin/organizations')
export class PlatformAdminController {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(OrganizationService) private readonly organizations: OrganizationService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(ClientIpResolver) private readonly ipResolver: ClientIpResolver,
  ) {}

  @Post()
  @ApiBody({ type: CreateOrganizationDto })
  @ApiCreatedResponse({ type: ProvisionedOrganizationDto })
  @ApiResponse({ status: 409, description: 'Organization slug already in use' })
  async create(
    @CurrentAuth() auth: SessionContext,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ProvisionedOrganizationDto> {
    const { ownerEmail, ownerFullName, ...input } = parseInput(createOrganizationInput, body);
    const meta = requestMetaFrom(req, this.ipResolver);
    const { org, invitation } = await this.run(auth, '', async (actor) => {
      const org = await this.organizations.create(actor.tx, actor.userId, input, meta);
      const invitation =
        ownerEmail &&
        (await this.invitations.issueOwner(
          { ...actor, orgId: org.id },
          { email: ownerEmail, fullName: ownerFullName },
          meta,
        ));
      return { org, invitation };
    });
    return invitation
      ? { ...org, ownerInvitation: await this.invitations.deliver(invitation) }
      : org;
  }

  @Get()
  @ApiQuery({ name: 'cursor', type: String, format: 'uuid', required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiOkResponse({ type: OrganizationPageDto })
  list(@CurrentAuth() auth: SessionContext, @Query() query: unknown): Promise<OrganizationPageDto> {
    const page = parseInput(organizationPageInput, query);
    return this.run(auth, '', ({ tx }) => this.organizations.list(tx, page));
  }

  @Get(':id')
  @organizationParam()
  @ApiOkResponse({ type: OrganizationDto })
  get(@CurrentAuth() auth: SessionContext, @Param('id') id: string): Promise<OrganizationDto> {
    return this.run(auth, resourceId(id), ({ tx, orgId }) => this.organizations.get(tx, orgId));
  }

  @Patch(':id')
  @organizationParam()
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiOkResponse({ type: OrganizationDto })
  update(
    @CurrentAuth() auth: SessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<OrganizationDto> {
    return this.updateOrganization(auth, id, parseInput(updateOrganizationInput, body), req);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @organizationParam()
  @ApiOkResponse({ type: OrganizationDto })
  suspend(
    @CurrentAuth() auth: SessionContext,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<OrganizationDto> {
    return this.updateOrganization(auth, id, { status: 'suspended' }, req);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @organizationParam()
  @ApiOkResponse({ type: OrganizationDto })
  reactivate(
    @CurrentAuth() auth: SessionContext,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<OrganizationDto> {
    return this.updateOrganization(auth, id, { status: 'active' }, req);
  }

  @Post(':id/owner-invitation')
  @organizationParam()
  @ApiBody({ type: OwnerInvitationDto })
  @ApiCreatedResponse({ type: InvitationDeliveryDto })
  @ApiResponse({ status: 409, description: 'Organization already has an owner' })
  async inviteOwner(
    @CurrentAuth() auth: SessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<InvitationDeliveryDto> {
    const input = parseInput(ownerInviteInput, body);
    const meta = requestMetaFrom(req, this.ipResolver);
    const invitation = await this.run(auth, resourceId(id), async (actor) => {
      await this.organizations.get(actor.tx, actor.orgId, true);
      return this.invitations.issueOwner(actor, input, meta);
    });
    return this.invitations.deliver(invitation);
  }

  private run<T>(
    auth: SessionContext,
    orgId: string,
    operation: (actor: OrganizationActor) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.connection.db, { orgId, userId: auth.userId }, (tx) =>
      operation({ orgId, userId: auth.userId, tx }),
    );
  }

  private updateOrganization(
    auth: SessionContext,
    id: string,
    input: Parameters<OrganizationService['update']>[1],
    req: Request,
  ): Promise<OrganizationDto> {
    const meta = requestMetaFrom(req, this.ipResolver);
    return this.run(auth, resourceId(id), async (actor) => {
      await this.organizations.get(actor.tx, actor.orgId, true);
      return this.organizations.update(actor, input, meta);
    });
  }
}

@Module({
  imports: [database, identityCore, TenancyModule],
  controllers: [PlatformAdminController],
})
export class PlatformAdminModule {}
