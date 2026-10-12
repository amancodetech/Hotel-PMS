/**
 * Deployment profile validation for staging/production (D-12).
 *
 * This module is deliberately NOT wired into `loadConfig`: the application
 * runtime keeps its existing local-only guard (NODE_ENV development|test and
 * loopback-only URLs). It exists so that a future deployment can be checked
 * against TLS/secrets/RLS/monitoring/backup/cost requirements and fail closed
 * before any resource is created. Passing this validation is a prerequisite,
 * not an authorization to deploy.
 */

export type DeploymentProfileName = 'staging' | 'production';

export interface DeploymentProfileIssue {
  field: string;
  problem: string;
}

export interface DeploymentProfileFieldState {
  field: string;
  state: 'SET' | 'MISSING' | 'INVALID';
  detail: string;
}

export interface DeploymentProfileResult {
  ok: boolean;
  profile: DeploymentProfileName;
  issues: DeploymentProfileIssue[];
  fields: DeploymentProfileFieldState[];
}

const SECRET_MIN = 32;
const loopbackHosts = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
]);
// Output is fail-closed: even known URLs/references may contain credentials.
// Only validated operational enum/numeric settings are safe to display.
const displayFields = new Set([
  'DEPLOYMENT_PROFILE',
  'NODE_ENV',
  'API_PORT',
  'WORKER_PORT',
  'WEB_PORT',
  'SESSION_COOKIE_SECURE',
  'SESSION_TTL_MINUTES',
  'SECRET_SOURCE',
  'RLS_ENFORCEMENT',
  'TENANT_CONTEXT_MODE',
  'LOG_LEVEL',
  'BACKUP_RETENTION_DAYS',
  'RESTORE_RPO_TARGET_MINUTES',
  'RESTORE_RTO_TARGET_MINUTES',
  'DISTRIBUTION_WORKER',
]);

function issue(
  issues: DeploymentProfileIssue[],
  field: string,
  problem: string,
): void {
  issues.push({ field, problem });
}

function requireValue(
  env: Record<string, string | undefined>,
  issues: DeploymentProfileIssue[],
  field: string,
): string {
  const value = env[field]?.trim();
  if (!value) {
    issue(issues, field, 'missing');
    return '';
  }
  return value;
}

function parseUrl(
  env: Record<string, string | undefined>,
  issues: DeploymentProfileIssue[],
  field: string,
): URL | null {
  const value = requireValue(env, issues, field);
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    issue(issues, field, 'not a valid URL');
    return null;
  }
}

function assertPublicHost(
  issues: DeploymentProfileIssue[],
  field: string,
  url: URL | null,
): void {
  if (!url) return;
  if (loopbackHosts.has(url.hostname.toLowerCase()))
    issue(issues, field, 'must not point to a local/loopback host');
}

function parsePositiveInt(
  env: Record<string, string | undefined>,
  issues: DeploymentProfileIssue[],
  field: string,
  { min, max }: { min: number; max: number },
): number | null {
  const value = requireValue(env, issues, field);
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    issue(issues, field, 'must be a positive integer');
    return null;
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    issue(issues, field, `must be between ${min} and ${max}`);
    return null;
  }
  return parsed;
}

function checkPostgresUrl(
  env: Record<string, string | undefined>,
  issues: DeploymentProfileIssue[],
  field: string,
): URL | null {
  const url = parseUrl(env, issues, field);
  if (!url) return null;
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    issue(issues, field, 'must be a postgres:// URL');
  assertPublicHost(issues, field, url);
  if (!url.password || url.password.length < 8)
    issue(
      issues,
      field,
      'must carry a database password of at least 8 characters',
    );
  const sslmode = url.searchParams.get('sslmode');
  if (!sslmode || !['require', 'verify-ca', 'verify-full'].includes(sslmode))
    issue(
      issues,
      field,
      'must set sslmode=require|verify-ca|verify-full (TLS)',
    );
  return url;
}

function describeValue(
  env: Record<string, string | undefined>,
  field: string,
): DeploymentProfileFieldState {
  const value = env[field]?.trim();
  if (!value) return { field, state: 'MISSING', detail: 'empty' };
  if (
    !displayFields.has(field) ||
    !/^(?:[a-z][a-z-]*|true|false|[0-9]+)$/.test(value)
  )
    return { field, state: 'SET', detail: `redacted(len=${value.length})` };
  return { field, state: 'SET', detail: value };
}

export function validateDeploymentProfile(
  env: Record<string, string | undefined>,
  profile: DeploymentProfileName,
): DeploymentProfileResult {
  const issues: DeploymentProfileIssue[] = [];
  const checkedFields: string[] = [];

  const declared = requireValue(env, issues, 'DEPLOYMENT_PROFILE');
  checkedFields.push('DEPLOYMENT_PROFILE');
  if (declared && declared !== profile)
    issue(issues, 'DEPLOYMENT_PROFILE', `must equal ${profile}`);

  const nodeEnv = requireValue(env, issues, 'NODE_ENV');
  checkedFields.push('NODE_ENV');
  if (nodeEnv && nodeEnv !== 'production')
    issue(issues, 'NODE_ENV', 'staging/production must run in production mode');

  const host = requireValue(env, issues, 'API_HOST');
  checkedFields.push('API_HOST');
  if (host && loopbackHosts.has(host.toLowerCase()))
    issue(issues, 'API_HOST', 'must not be a local/loopback host');

  const ports = new Map<string, number>();
  for (const field of ['API_PORT', 'WORKER_PORT', 'WEB_PORT']) {
    checkedFields.push(field);
    const parsed = parsePositiveInt(env, issues, field, {
      min: 1024,
      max: 65535,
    });
    if (parsed !== null) ports.set(field, parsed);
  }
  if (ports.size === 3 && new Set(ports.values()).size !== 3)
    issue(issues, 'API_PORT,WORKER_PORT,WEB_PORT', 'must be distinct');

  for (const field of ['WEB_ORIGIN', 'API_ORIGIN']) {
    checkedFields.push(field);
    const url = parseUrl(env, issues, field);
    assertPublicHost(issues, field, url);
    if (url && url.protocol !== 'https:')
      issue(issues, field, 'must use https://');
  }

  const dbFields = [
    'DATABASE_URL',
    'API_DATABASE_URL',
    'WORKER_DATABASE_URL',
    'MIGRATION_DATABASE_URL',
  ];
  checkedFields.push(...dbFields);
  const dbUrls = new Map<string, URL>();
  for (const field of dbFields) {
    const url = checkPostgresUrl(env, issues, field);
    if (url) dbUrls.set(field, url);
  }
  const apiUser = dbUrls.get('API_DATABASE_URL')?.username;
  const workerUser = dbUrls.get('WORKER_DATABASE_URL')?.username;
  if (apiUser && workerUser && apiUser === workerUser)
    issue(
      issues,
      'API_DATABASE_URL,WORKER_DATABASE_URL',
      'API and worker must use distinct least-privilege roles',
    );

  checkedFields.push('REDIS_URL');
  const redis = parseUrl(env, issues, 'REDIS_URL');
  assertPublicHost(issues, 'REDIS_URL', redis);
  if (redis) {
    if (redis.protocol !== 'rediss:')
      issue(issues, 'REDIS_URL', 'must use rediss:// (TLS)');
    if (!redis.password || redis.password.length < 16)
      issue(
        issues,
        'REDIS_URL',
        'must carry a Redis password of at least 16 characters',
      );
  }

  checkedFields.push('KEYCLOAK_ISSUER', 'KEYCLOAK_CLIENT_SECRET');
  const issuer = parseUrl(env, issues, 'KEYCLOAK_ISSUER');
  assertPublicHost(issues, 'KEYCLOAK_ISSUER', issuer);
  if (issuer && issuer.protocol !== 'https:')
    issue(issues, 'KEYCLOAK_ISSUER', 'must use https://');
  const clientSecret = env.KEYCLOAK_CLIENT_SECRET?.trim() ?? '';
  if (!clientSecret) issue(issues, 'KEYCLOAK_CLIENT_SECRET', 'missing');
  else if (clientSecret.length < SECRET_MIN)
    issue(
      issues,
      'KEYCLOAK_CLIENT_SECRET',
      `must be at least ${SECRET_MIN} characters`,
    );

  checkedFields.push('SESSION_COOKIE_SECURE');
  if ((env.SESSION_COOKIE_SECURE ?? '').trim() !== 'true')
    issue(
      issues,
      'SESSION_COOKIE_SECURE',
      'must be true outside local development',
    );
  checkedFields.push('SESSION_TTL_MINUTES');
  parsePositiveInt(env, issues, 'SESSION_TTL_MINUTES', { min: 5, max: 1440 });

  checkedFields.push('SECRET_SOURCE');
  const secretSource = requireValue(env, issues, 'SECRET_SOURCE');
  if (secretSource && !['aws-secrets-manager', 'vault'].includes(secretSource))
    issue(
      issues,
      'SECRET_SOURCE',
      'must be aws-secrets-manager or vault, never plain env files',
    );

  checkedFields.push('RLS_ENFORCEMENT', 'TENANT_CONTEXT_MODE');
  if ((env.RLS_ENFORCEMENT ?? '').trim() !== 'require-force')
    issue(issues, 'RLS_ENFORCEMENT', 'must be require-force');
  if ((env.TENANT_CONTEXT_MODE ?? '').trim() !== 'session')
    issue(issues, 'TENANT_CONTEXT_MODE', 'must be session');

  checkedFields.push('LOG_LEVEL');
  const logLevel = requireValue(env, issues, 'LOG_LEVEL');
  if (logLevel && !['info', 'warn', 'error'].includes(logLevel))
    issue(
      issues,
      'LOG_LEVEL',
      'must be info, warn or error (no debug payloads)',
    );

  for (const field of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'ALERT_WEBHOOK_URL']) {
    checkedFields.push(field);
    const url = parseUrl(env, issues, field);
    assertPublicHost(issues, field, url);
    if (url && url.protocol !== 'https:')
      issue(issues, field, 'must use https://');
  }

  checkedFields.push(
    'BACKUP_TARGET',
    'BACKUP_SCHEDULE_CRON',
    'BACKUP_RETENTION_DAYS',
    'RESTORE_RPO_TARGET_MINUTES',
    'RESTORE_RTO_TARGET_MINUTES',
  );
  const backupTarget = requireValue(env, issues, 'BACKUP_TARGET');
  if (backupTarget && !/^s3:\/\/[^/]+\/.+/.test(backupTarget))
    issue(issues, 'BACKUP_TARGET', 'must be an s3://bucket/prefix target');
  requireValue(env, issues, 'BACKUP_SCHEDULE_CRON');
  parsePositiveInt(env, issues, 'BACKUP_RETENTION_DAYS', { min: 7, max: 3650 });
  parsePositiveInt(env, issues, 'RESTORE_RPO_TARGET_MINUTES', {
    min: 1,
    max: 1440,
  });
  parsePositiveInt(env, issues, 'RESTORE_RTO_TARGET_MINUTES', {
    min: 1,
    max: 1440,
  });

  checkedFields.push('DISTRIBUTION_WORKER');
  const distributionWorker = requireValue(env, issues, 'DISTRIBUTION_WORKER');
  if (distributionWorker && !['on', 'off'].includes(distributionWorker))
    issue(issues, 'DISTRIBUTION_WORKER', 'must be on or off');
  if (distributionWorker === 'on') {
    checkedFields.push('LIVE_PROVIDER_KEYS', 'CHANNEL_LIVE_AUTHORIZATION_REF');
    const providers = (env.LIVE_PROVIDER_KEYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (providers.length === 0)
      issue(issues, 'LIVE_PROVIDER_KEYS', 'must list the live provider keys');
    if (providers.includes('simulator'))
      issue(
        issues,
        'LIVE_PROVIDER_KEYS',
        'simulator must never run in staging/production',
      );
    requireValue(env, issues, 'CHANNEL_LIVE_AUTHORIZATION_REF');
  }

  if (profile === 'production') {
    checkedFields.push(
      'COST_APPROVAL_REF',
      'PRODUCTION_AUTHORIZATION_REF',
      'RESTORE_TEST_REF',
    );
    requireValue(env, issues, 'COST_APPROVAL_REF');
    requireValue(env, issues, 'PRODUCTION_AUTHORIZATION_REF');
    requireValue(env, issues, 'RESTORE_TEST_REF');
  }

  const fields = [...new Set(checkedFields)].map((field) => {
    const described = describeValue(env, field);
    if (
      described.state === 'SET' &&
      issues.some((entry) => entry.field === field)
    )
      return {
        ...described,
        detail: `redacted(len=${env[field]?.trim().length ?? 0})`,
      };
    return described;
  });

  return { ok: issues.length === 0, profile, issues, fields };
}

export function formatDeploymentIssues(
  result: DeploymentProfileResult,
): string {
  return result.issues
    .map((entry) => `${entry.field}: ${entry.problem}`)
    .join('; ');
}
