import { isIP } from 'node:net';
import { z } from 'zod';

const commonConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

function isCidrOrIp(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** Comma-separated list of CIDRs or single IPs of reverse proxies whose X-Forwarded-For is trusted. */
const trustedProxyCidrs = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine((entries) => entries.every(isCidrOrIp), {
    message: 'TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs or IP addresses.',
  });

const apiConfigSchema = commonConfigSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url(),
  TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
  SMTP_HOST: z.string().trim().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  MAIL_FROM: z.email().default('no-reply@clinik.test'),
  APP_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => {
      const url = new URL(value);
      return url.username === '' && url.password === '' && url.href === `${url.origin}/`;
    }, 'APP_BASE_URL must be an HTTP(S) origin.')
    .default('http://127.0.0.1:3000'),
});

const workerConfigSchema = commonConfigSchema.extend({
  WORKER_DATABASE_URL: z.string().url(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return apiConfigSchema.parse(env);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerConfigSchema.parse(env);
}
