import { z } from 'zod';

const localUrl = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        protocols.includes(url.protocol) &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      );
    });
const port = z.coerce.number().int().min(1024).max(65535);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test']),
  API_HOST: z.literal('127.0.0.1'),
  API_PORT: port,
  WORKER_PORT: port,
  WEB_PORT: port,
  DATABASE_URL: localUrl(['postgres:', 'postgresql:']),
  API_DATABASE_URL: localUrl(['postgres:', 'postgresql:']),
  WORKER_DATABASE_URL: localUrl(['postgres:', 'postgresql:']),
  REDIS_URL: localUrl(['redis:']),
  KEYCLOAK_HEALTH_URL: localUrl(['http:']),
  KEYCLOAK_ISSUER: localUrl(['http:']),
  KEYCLOAK_CLIENT_ID: z.string().min(1).max(200),
  KEYCLOAK_CLIENT_SECRET: z.string().min(16).max(200),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(480),
  DISTRIBUTION_WORKER: z.enum(['on', 'off']).default('off'),
  CHANNEX_STAGING_WORKER: z.enum(['on', 'off']).default('off'),
  CHANNEX_STAGING_TENANT_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_PROPERTY_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_CONNECTION_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_EXTERNAL_PROPERTY_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_EXTERNAL_ROOM_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_EXTERNAL_RATE_ID: z.string().uuid().optional(),
  CHANNEX_STAGING_DATE: z.literal('2026-10-15').optional(),
  CHANNEX_STAGING_MAX_TICKS: z.coerce.number().int().min(1).max(3).default(1),
  NIGHT_AUDIT_WORKER: z.enum(['on', 'off']).default('on'),
  NIGHT_AUDIT_POLL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60000)
    .default(1500),
  NIGHT_AUDIT_LEASE_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(60000),
  NIGHT_AUDIT_STEP_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60000)
    .default(0),
  REPORT_EXPORT_WORKER: z.enum(['on', 'off']).default('on'),
  REPORT_EXPORT_POLL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60000)
    .default(1500),
  REPORT_EXPORT_LEASE_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(60000),
});
export type AppConfig = z.infer<typeof schema>;

export const AUTH_CALLBACK_PATH = '/api/v1/auth/callback';
export function apiOrigin(config: AppConfig): string {
  return `http://${config.API_HOST}:${config.API_PORT}`;
}
export function webOrigin(config: AppConfig): string {
  return `http://${config.API_HOST}:${config.WEB_PORT}`;
}
export function redirectUri(config: AppConfig): string {
  return `${apiOrigin(config)}${AUTH_CALLBACK_PATH}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  if (
    new Set([
      result.data.API_PORT,
      result.data.WORKER_PORT,
      result.data.WEB_PORT,
    ]).size !== 3
  ) {
    throw new Error(
      'Invalid configuration: application ports must be distinct',
    );
  }
  return Object.freeze(result.data);
}
