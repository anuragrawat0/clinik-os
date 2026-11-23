import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Require } from '../../core/access/access';
import { parseInput } from '../../core/errors/http-validation';
import {
  CurrentTenant,
  type TenantOperation,
} from '../../core/tenancy-context/request-transaction';
import { ClientIpResolver, requestMetaFrom } from '../identity/core';
import { InvitationService } from './invitation.service';
import { MemberService } from './member.service';
import { OrganizationService } from './organization.service';
import {
  BranchDto,
  CreateBranchDto,
  InvitationDeliveryDto,
  MemberDto,
  OrganizationDto,
  OwnershipTransferDto,
  ReplaceRolesDto,
  StaffInvitationDto,
  UpdateBranchDto,
  UpdateOrganizationDto,
  createBranchInput,
  createInvitationInput,
  ownershipTransferInput,
  replaceRolesInput,
  resourceId,
  updateBranchInput,
  updateOrganizationInput,
} from './tenancy.dto';

@ApiTags('organizations')
@ApiCookieAuth()
@ApiParam({ name: 'orgId', type: String, format: 'uuid' })
@ApiResponse({ status: 404, description: 'Resource unavailable' })
@ApiResponse({ status: 403, description: 'Permission denied' })
@Controller('orgs/:orgId')
export class OrganizationController {
  constructor(
    @Inject(OrganizationService) private readonly organizations: OrganizationService,
    @Inject(MemberService) private readonly members: MemberService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(ClientIpResolver) private readonly ipResolver: ClientIpResolver,
  ) {}

  @Get()
  @Require('org.read')
  @ApiOkResponse({ type: OrganizationDto })
  get(@CurrentTenant() tenant: TenantOperation): Promise<OrganizationDto> {
    return this.organizations.get(tenant.tx, tenant.orgId);
  }

  @Patch()
  @Require('org.update')
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiOkResponse({ type: OrganizationDto })
  update(
    @CurrentTenant() tenant: TenantOperation,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<OrganizationDto> {
    return this.organizations.update(
      tenant,
      parseInput(updateOrganizationInput, body),
      requestMetaFrom(req, this.ipResolver),
    );
  }

  @Get('branches')
  @Require('org.read')
  @ApiOkResponse({ type: [BranchDto] })
  listBranches(@CurrentTenant() tenant: TenantOperation): Promise<BranchDto[]> {
    return this.organizations.listBranches(tenant);
  }

  @Post('branches')
  @Require('branch.manage')
  @ApiBody({ type: CreateBranchDto })
  @ApiCreatedResponse({ type: BranchDto })
  @ApiResponse({ status: 409, description: 'Branch code already in use' })
  @ApiResponse({ status: 422, description: 'Invalid timezone' })
  createBranch(
    @CurrentTenant() tenant: TenantOperation,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<BranchDto> {
    return this.organizations.createBranch(
      tenant,
      parseInput(createBranchInput, body),
      requestMetaFrom(req, this.ipResolver),
    );
  }

  @Get('branches/:id')
  @Require('org.read')
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiOkResponse({ type: BranchDto })
  getBranch(@CurrentTenant() tenant: TenantOperation, @Param('id') id: string): Promise<BranchDto> {
    return this.organizations.getBranch(tenant, resourceId(id));
  }

  @Patch('branches/:id')
  @Require('branch.update')
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateBranchDto })
  @ApiOkResponse({ type: BranchDto })
  @ApiResponse({ status: 409, description: 'Branch code already in use' })
  @ApiResponse({ status: 422, description: 'Invalid timezone' })
  updateBranch(
    @CurrentTenant() tenant: TenantOperation,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<BranchDto> {
    return this.organizations.updateBranch(
      tenant,
      resourceId(id),
      parseInput(updateBranchInput, body),
      requestMetaFrom(req, this.ipResolver),
    );
  }

  @Get('members')
  @Require('member.list')
  @ApiOkResponse({ type: [MemberDto] })
  listMembers(@CurrentTenant() tenant: TenantOperation): Promise<MemberDto[]> {
    return this.members.list(tenant);
  }

  @Post('invitations')
  @Require('member.manage')
  @ApiBody({ type: StaffInvitationDto })
  @ApiCreatedResponse({ type: InvitationDeliveryDto })
  @ApiResponse({ status: 409, description: 'Assignment already held or invitation pending' })
  @ApiResponse({ status: 422, description: 'Branch is inactive' })
  async invite(
    @CurrentTenant() tenant: TenantOperation,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<InvitationDeliveryDto> {
    const invitation = await this.invitations.issueStaff(
      tenant,
      parseInput(createInvitationInput, body),
      requestMetaFrom(req, this.ipResolver),
    );
    const response: InvitationDeliveryDto = {
      id: invitation.id,
      expiresAt: invitation.expiresAt,
      emailDelivery: 'failed',
    };
    tenant.afterCommit(async () => {
      response.emailDelivery = (await this.invitations.deliver(invitation)).emailDelivery;
    });
    return response;
  }

  @Delete('invitations/:id')
  @Require('member.manage')
  @HttpCode(204)
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiNoContentResponse()
  revokeInvitation(
    @CurrentTenant() tenant: TenantOperation,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.invitations.revoke(tenant, resourceId(id), requestMetaFrom(req, this.ipResolver));
  }

  @Put('members/:userId/roles')
  @Require('member.manage')
  @HttpCode(204)
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiBody({ type: ReplaceRolesDto })
  @ApiNoContentResponse()
  replaceRoles(
    @CurrentTenant() tenant: TenantOperation,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const { roles } = parseInput(replaceRolesInput, body);
    return this.members.replaceRoles(
      tenant,
      resourceId(userId),
      roles,
      requestMetaFrom(req, this.ipResolver),
    );
  }

  @Delete('members/:userId')
  @Require('member.manage')
  @HttpCode(204)
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiNoContentResponse()
  removeMember(
    @CurrentTenant() tenant: TenantOperation,
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.remove(tenant, resourceId(userId), requestMetaFrom(req, this.ipResolver));
  }

  @Post('ownership-transfer')
  @Require('org.ownership.transfer')
  @HttpCode(204)
  @ApiBody({ type: OwnershipTransferDto })
  @ApiNoContentResponse()
  @ApiResponse({ status: 422, description: 'Current password is incorrect' })
  transferOwnership(
    @CurrentTenant() tenant: TenantOperation,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.transferOwnership(
      tenant,
      parseInput(ownershipTransferInput, body),
      requestMetaFrom(req, this.ipResolver),
    );
  }
}
