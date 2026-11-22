import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const fullName = z
  .string()
  .trim()
  .refine((name) => {
    const length = [...name].length;
    return length >= 1 && length <= 200 && !name.includes('\0');
  });
const password = z.string().max(1024);
export const acceptInvitationInput = z.strictObject({
  fullName: fullName.optional(),
  password: password.optional(),
});

export class AcceptInvitationDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 200 })
  fullName?: string;

  @ApiPropertyOptional({ type: String, format: 'password', maxLength: 1024 })
  password?: string;
}

export class InvitationPreviewDto {
  @ApiProperty({ type: String })
  organizationName!: string;

  @ApiProperty({ type: String })
  role!: string;

  @ApiProperty({ type: String, nullable: true })
  branchName!: string | null;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;
}
