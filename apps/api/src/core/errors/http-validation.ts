import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpException({ code: 'INVALID_REQUEST' }, HttpStatus.BAD_REQUEST);
  return parsed.data;
}
