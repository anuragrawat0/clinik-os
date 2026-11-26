import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthUser, SessionRecord } from './core';

const email = z.string().trim().max(254).pipe(z.email());
const password = z.string().max(1024);
const token = z.string().min(1).max(256);

export const loginInput = z.strictObject({ email, password });
export const forgotInput = z.strictObject({ email });
export const resetInput = z.strictObject({ token, password });
export const verifyInput = z.strictObject({ token });

export class LoginDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  email!: string;

  @ApiProperty({ type: String, format: 'password', maxLength: 1024 })
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 254 })
  email!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 256 })
  token!: string;
}

export class ResetPasswordDto extends VerifyEmailDto {
  @ApiProperty({ type: String, format: 'password', maxLength: 1024 })
  password!: string;
}

class UserDto implements AuthUser {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: Boolean })
  isPlatformAdmin!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt!: Date | null;
}

export class LoginResponseDto {
  @ApiProperty({ type: UserDto })
  user!: AuthUser;
}

export class ForgotResponseDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  accepted!: true;
}

class RoleDto {
  @ApiProperty({ type: String })
  role!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  branchId!: string | null;
}

class MembershipDto {
  @ApiProperty({ type: String, format: 'uuid' })
  organizationId!: string;

  @ApiProperty({ type: String })
  organizationName!: string;

  @ApiProperty({ type: String })
  organizationSlug!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String })
  organizationStatus!: string;

  @ApiProperty({ type: [RoleDto] })
  roles!: RoleDto[];
}

export class MeResponseDto extends LoginResponseDto {
  @ApiProperty({ type: [MembershipDto] })
  memberships!: MembershipDto[];

  @ApiProperty({ type: 'array', items: { type: 'object' }, maxItems: 0 })
  patientProfiles!: [];
}

export class SessionDto implements Omit<SessionRecord, 'userId'> {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  lastSeenAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  idleExpiresAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  absoluteExpiresAt!: Date;

  @ApiProperty({ type: Boolean })
  current!: boolean;
}
