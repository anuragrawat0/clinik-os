import { staffRoles } from '@clinik/shared';
import { HttpException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { notFound } from '../../core/access/access';
import { pageLimit } from '../../core/pagination/cursor';

const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'));
const email = z.email().max(254);
const timezone = z.string().max(100);
const validTimezones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const uuid = z.guid().transform((id) => id.toLowerCase());
const slugPattern = '^[a-z0-9][a-z0-9-]{2,62}$';
const branchCodePattern = '^[A-Z0-9-]{2,16}$';
const branchStatuses = ['active', 'inactive'] as const;

export function resourceId(value: string): string {
  const result = uuid.safeParse(value);
  return result.success ? result.data : notFound();
}

export function validateTimezone(value: string | undefined): void {
  if (value !== undefined && !validTimezones.has(value)) {
    throw new HttpException({ code: 'INVALID_TIMEZONE' }, 422);
  }
}

export const ownerInviteInput = z.strictObject({
  email,
  fullName: name.optional(),
});

export const createOrganizationInput = z
  .strictObject({
    name,
    slug: z.string().regex(new RegExp(slugPattern)),
    defaultTimezone: timezone,
    ownerEmail: email.optional(),
    ownerFullName: name.optional(),
  })
  .refine(
    ({ ownerEmail, ownerFullName }) => ownerEmail !== undefined || ownerFullName === undefined,
  );

export const updateOrganizationInput = z
  .strictObject({
    name: name.optional(),
    defaultTimezone: timezone.optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

export const organizationPageInput = z.strictObject({
  cursor: uuid.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(25),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes('\0'))
    .nullable()
    .optional();

export const createBranchInput = z.strictObject({
  name,
  code: z.string().regex(new RegExp(branchCodePattern)),
  timezone,
  phone: optionalText(50),
  email: email.nullable().optional(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(30),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
});

export const updateBranchInput = createBranchInput
  .partial()
  .extend({ status: z.enum(branchStatuses).optional() })
  .refine((input) => Object.keys(input).length > 0);

const roleShape = {
  role: z.enum(staffRoles),
  branchId: uuid.nullish().transform((id) => id ?? null),
};
const roleScopeValid = ({ role, branchId }: { role: string; branchId: string | null }) =>
  (role === 'org_owner' || role === 'org_admin') === (branchId === null);

export const createInvitationInput = z.strictObject({ email, ...roleShape }).refine(roleScopeValid);
export const invitationListQuery = z.strictObject({
  status: z.enum(['pending', 'all']).default('pending'),
  cursor: z.unknown().optional(),
  limit: pageLimit,
});
export type InvitationListQuery = z.output<typeof invitationListQuery>;
const invitationStatuses = ['pending', 'accepted', 'revoked', 'expired'] as const;
const assignmentInput = z.strictObject(roleShape).refine(roleScopeValid);
export type StaffAssignment = z.output<typeof assignmentInput>;

export const replaceRolesInput = z.strictObject({
  roles: z
    .array(assignmentInput)
    .refine((roles) => new Set(roles.map(roleKey)).size === roles.length),
});

export function roleKey({ role, branchId }: StaffAssignment): string {
  return `${role}:${branchId ?? ''}`;
}

export const ownershipTransferInput = z.strictObject({
  newOwnerUserId: uuid,
  currentPassword: z.string().max(1024),
});

const date = { type: String, format: 'date-time' };
const id = { type: String, format: 'uuid' };
const emailProperty = { type: String, format: 'email' };

export class CreateOrganizationDto {
  @ApiProperty({ type: String, maxLength: 200 }) name!: string;
  @ApiProperty({ type: String, pattern: slugPattern }) slug!: string;
  @ApiProperty({ type: String }) defaultTimezone!: string;
  @ApiPropertyOptional(emailProperty) ownerEmail?: string;
  @ApiPropertyOptional({ type: String, maxLength: 200 }) ownerFullName?: string;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ type: String, maxLength: 200 }) name?: string;
  @ApiPropertyOptional({ type: String }) defaultTimezone?: string;
}

class OrganizationSummaryDto {
  @ApiProperty(id) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: string;
}

export class OrganizationDto extends OrganizationSummaryDto {
  @ApiProperty({ type: String }) slug!: string;
  @ApiProperty({ type: String }) defaultTimezone!: string;
  @ApiProperty({ type: String }) currency!: string;
  @ApiProperty(date) createdAt!: Date;
  @ApiProperty(date) updatedAt!: Date;
}

export class OrganizationPageDto {
  @ApiProperty({ type: [OrganizationSummaryDto] }) items!: OrganizationSummaryDto[];
  @ApiProperty({ ...id, nullable: true }) nextCursor!: string | null;
}

export class OwnerInvitationDto {
  @ApiProperty(emailProperty) email!: string;
  @ApiPropertyOptional({ type: String, maxLength: 200 }) fullName?: string;
}

export class InvitationDeliveryDto {
  @ApiProperty(id) id!: string;
  @ApiProperty(date) expiresAt!: Date;
  @ApiProperty({ enum: ['sent', 'failed'] }) emailDelivery!: 'sent' | 'failed';
}

export class InvitationListItemDto {
  @ApiProperty(id) id!: string;
  @ApiProperty(emailProperty) email!: string;
  @ApiProperty({ enum: staffRoles }) role!: string;
  @ApiProperty({ ...id, nullable: true }) branchId!: string | null;
  @ApiProperty(date) expiresAt!: Date;
  @ApiProperty(id) invitedBy!: string;
  @ApiProperty(date) createdAt!: Date;
  @ApiProperty({ enum: invitationStatuses }) status!: (typeof invitationStatuses)[number];
}

export class InvitationPageDto {
  @ApiProperty({ type: [InvitationListItemDto] }) items!: InvitationListItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ProvisionedOrganizationDto extends OrganizationDto {
  @ApiPropertyOptional({ type: InvitationDeliveryDto }) ownerInvitation?: InvitationDeliveryDto;
}

class BranchDetailsDto {
  @ApiPropertyOptional({ type: String, nullable: true }) phone?: string | null;
  @ApiPropertyOptional({ ...emailProperty, nullable: true }) email?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) addressLine1?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) addressLine2?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) city?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) region?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) postalCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) country?: string | null;
}

export class CreateBranchDto extends BranchDetailsDto {
  @ApiProperty({ type: String, maxLength: 200 }) name!: string;
  @ApiProperty({ type: String, pattern: branchCodePattern }) code!: string;
  @ApiProperty({ type: String }) timezone!: string;
}

export class UpdateBranchDto extends BranchDetailsDto {
  @ApiPropertyOptional({ type: String, maxLength: 200 }) name?: string;
  @ApiPropertyOptional({ type: String, pattern: branchCodePattern }) code?: string;
  @ApiPropertyOptional({ type: String }) timezone?: string;
  @ApiPropertyOptional({ enum: branchStatuses }) status?: string;
}

export class BranchDto extends CreateBranchDto {
  @ApiProperty(id) id!: string;
  @ApiProperty(id) organizationId!: string;
  @ApiProperty({ enum: branchStatuses }) status!: string;
  @ApiProperty(date) createdAt!: Date;
  @ApiProperty(date) updatedAt!: Date;
}

export class StaffAssignmentDto {
  @ApiProperty({ enum: staffRoles }) role!: StaffAssignment['role'];
  @ApiPropertyOptional({ ...id, nullable: true }) branchId?: string | null;
}

export class StaffInvitationDto extends StaffAssignmentDto {
  @ApiProperty(emailProperty) email!: string;
}

export class ReplaceRolesDto {
  @ApiProperty({ type: [StaffAssignmentDto] }) roles!: StaffAssignmentDto[];
}

export class MemberDto {
  @ApiProperty(id) userId!: string;
  @ApiProperty(emailProperty) email!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty(date) joinedAt!: Date;
  @ApiProperty({ type: [StaffAssignmentDto] }) roles!: StaffAssignmentDto[];
  @ApiProperty({ type: Boolean, description: 'Whether the viewer can edit this member’s roles' })
  canEditRoles!: boolean;
  @ApiProperty({ type: Boolean, description: 'Whether the viewer can remove this member' })
  canRemove!: boolean;
}

export class OwnershipTransferDto {
  @ApiProperty(id) newOwnerUserId!: string;
  @ApiProperty({ type: String, format: 'password', maxLength: 1024 }) currentPassword!: string;
}
