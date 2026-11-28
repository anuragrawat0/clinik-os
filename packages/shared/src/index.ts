import { z } from 'zod';

export * from './rbac';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  database: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export { displayName } from './display-name.js';
export {
  canonicalTimeZone,
  isValidTimeZone,
  normalizeTimeZone,
  timeZoneOptions,
} from './time-zone.js';
