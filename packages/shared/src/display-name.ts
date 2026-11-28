import { z } from 'zod';

export const displayName = z
  .string()
  .normalize('NFC')
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll('\u200d', '')))
  .trim()
  .refine((value) => value.replace(/[\p{Z}\p{Cf}]/gu, '').length > 0);
