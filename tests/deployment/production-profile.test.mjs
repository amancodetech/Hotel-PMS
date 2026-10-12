import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { validateDeploymentProfile } from '../../packages/backend/dist/deployment/profile.js';

const secret = (label) => `${label}-${'x'.repeat(32)}`;

function completeEnv(profile) {
  return {
    DEPLOYMENT_PROFILE: profile,
    NODE_ENV: 'production',
    API_HOST: 'api.example.test',
    API_PORT: '8443',
    WORKER_PORT: '8444',
    WEB_PORT: '8445',
    WEB_ORIGIN: 'https://web.example.test',
    API_ORIGIN: 'https://api.example.test',
    DATABASE_URL:
      'postgresql://owner:ownerpass123@db.example.test:5432/hotel?sslmode=require',
    API_DATABASE_URL:
      'postgresql://hotel_api:apipass12345@db.example.test:5432/hotel?sslmode=require',
    WORKER_DATABASE_URL:
      'postgresql://hotel_worker:workerpass123@db.example.test:5432/hotel?sslmode=require',
    MIGRATION_DATABASE_URL:
      'postgresql://hotel_migrator:migratorpass123@db.example.test:5432/hotel?sslmode=require',
    REDIS_URL: 'rediss://hotel:redissecret123456@redis.example.test:6379/0',
    KEYCLOAK_ISSUER: 'https://identity.example.test/realms/hotel',
    KEYCLOAK_CLIENT_SECRET: secret('oidc'),
    SESSION_COOKIE_SECURE: 'true',
    SESSION_TTL_MINUTES: '480',
    SECRET_SOURCE: 'aws-secrets-manager',
    RLS_ENFORCEMENT: 'require-force',
    TENANT_CONTEXT_MODE: 'session',
    LOG_LEVEL: 'info',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
    ALERT_WEBHOOK_URL: 'https://alerts.example.test/hooks/hotel',
    BACKUP_TARGET: 's3://hotel-backups/postgres',
    BACKUP_SCHEDULE_CRON: '*/15 * * * *',
    BACKUP_RETENTION_DAYS: '14',
    RESTORE_RPO_TARGET_MINUTES: '15',
    RESTORE_RTO_TARGET_MINUTES: '60',
    DISTRIBUTION_WORKER: 'off',
    ...(profile === 'production'
      ? {
          COST_APPROVAL_REF: 'synthetic-cost-ref',
          PRODUCTION_AUTHORIZATION_REF: 'synthetic-authorization-ref',
          RESTORE_TEST_REF: 'synthetic-restore-ref',
        }
      : {}),
  };
}

function issuesFor(env, profile) {
  return validateDeploymentProfile(env, profile).issues.map(
    (entry) => `${entry.field}: ${entry.problem}`,
  );
}

describe('deployment profile validation', () => {
  test('production without secrets fails closed', () => {
    const result = validateDeploymentProfile({}, 'production');
    expect(result.ok).toBe(false);
    const fields = result.issues.map((entry) => entry.field);
    expect(fields).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'REDIS_URL']),
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        'COST_APPROVAL_REF',
        'PRODUCTION_AUTHORIZATION_REF',
        'RESTORE_TEST_REF',
      ]),
    );
  });

  test('complete synthetic production env passes', () => {
    const result = validateDeploymentProfile(
      completeEnv('production'),
      'production',
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('complete synthetic staging env passes without production-only refs', () => {
    const env = completeEnv('staging');
    delete env.COST_APPROVAL_REF;
    delete env.PRODUCTION_AUTHORIZATION_REF;
    delete env.RESTORE_TEST_REF;
    expect(validateDeploymentProfile(env, 'staging').ok).toBe(true);
  });

  test('loopback hosts are rejected', () => {
    const env = completeEnv('production');
    env.API_HOST = '127.0.0.1';
    expect(issuesFor(env, 'production')).toContainEqual(
      expect.stringContaining('must not be a local/loopback host'),
    );
  });

  test('postgres without sslmode is rejected', () => {
    const env = completeEnv('production');
    env.DATABASE_URL =
      'postgresql://owner:ownerpass123@db.example.test:5432/hotel';
    expect(issuesFor(env, 'production')).toContainEqual(
      expect.stringContaining('sslmode'),
    );
  });

  test('plain redis without TLS is rejected', () => {
    const env = completeEnv('production');
    env.REDIS_URL = 'redis://hotel:redissecret123456@redis.example.test:6379/0';
    expect(issuesFor(env, 'production')).toContainEqual(
      expect.stringContaining('rediss'),
    );
  });

  test('simulator is rejected for live distribution worker', () => {
    const env = completeEnv('production');
    env.DISTRIBUTION_WORKER = 'on';
    env.LIVE_PROVIDER_KEYS = 'simulator';
    env.CHANNEL_LIVE_AUTHORIZATION_REF = 'synthetic-live-ref';
    expect(issuesFor(env, 'production')).toContainEqual(
      expect.stringContaining('simulator must never run'),
    );
  });

  test('live distribution without an authorization ref is rejected', () => {
    const env = completeEnv('production');
    env.DISTRIBUTION_WORKER = 'on';
    env.LIVE_PROVIDER_KEYS = 'channex';
    expect(issuesFor(env, 'production')).toContainEqual(
      expect.stringContaining('CHANNEL_LIVE_AUTHORIZATION_REF'),
    );
  });

  test('shared API and worker database role is rejected', () => {
    const env = completeEnv('staging');
    env.WORKER_DATABASE_URL =
      'postgresql://hotel_api:apipass12345@db.example.test:5432/hotel?sslmode=require';
    expect(issuesFor(env, 'staging')).toContainEqual(
      expect.stringContaining('distinct least-privilege roles'),
    );
  });

  test('shipped environment examples fail until real secrets exist', () => {
    for (const profile of ['staging', 'production']) {
      const env = {};
      for (const rawLine of readFileSync(
        `infra/environments/${profile}.env.example`,
        'utf8',
      ).split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const value = line.slice(separator + 1).trim();
        if (value !== '') env[line.slice(0, separator).trim()] = value;
      }
      const result = validateDeploymentProfile(env, profile);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
  test('output omits unknown fields and redacts known URLs and authorization refs', () => {
    const env = completeEnv('production');
    env.PROVIDER_API_TOKEN = 'synthetic-provider-token';
    env.AWS_SECRET_ACCESS_KEY = 'synthetic-aws-secret';
    env.UNRECOGNIZED_FIELD = 'synthetic-unclassified-secret';
    for (const field of [
      'WEB_ORIGIN',
      'API_ORIGIN',
      'KEYCLOAK_ISSUER',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'ALERT_WEBHOOK_URL',
    ]) {
      env[field] =
        'https://user:synthetic-password@example.test/path?token=synthetic-query';
    }
    const result = validateDeploymentProfile(env, 'production');
    const output = JSON.stringify(result);
    for (const value of [
      'synthetic-provider-token',
      'synthetic-aws-secret',
      'synthetic-unclassified-secret',
      'synthetic-password',
      'synthetic-query',
      'synthetic-authorization-ref',
    ])
      expect(output).not.toContain(value);
    for (const unknown of [
      'PROVIDER_API_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'UNRECOGNIZED_FIELD',
    ])
      expect(result.fields.map(({ field }) => field)).not.toContain(unknown);
    expect(
      result.fields.find(({ field }) => field === 'WEB_ORIGIN').detail,
    ).toMatch(/^redacted/);
  });
});
