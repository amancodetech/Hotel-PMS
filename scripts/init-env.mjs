import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function localKey() {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW1234567890';
  return [...randomBytes(20)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');
}
const postgresPort = '55432';
const ownerPassword = randomBytes(24).toString('hex');
const redisPassword = randomBytes(24).toString('hex');
const apiDbPassword = randomBytes(24).toString('hex');
const workerDbPassword = randomBytes(24).toString('hex');
const testDbPassword = randomBytes(24).toString('hex');
const urls = {
  owner: `postgresql://hotel:${ownerPassword}@127.0.0.1:${postgresPort}/hotel`,
  api: `postgresql://hotel_api:${apiDbPassword}@127.0.0.1:${postgresPort}/hotel`,
  worker: `postgresql://hotel_worker:${workerDbPassword}@127.0.0.1:${postgresPort}/hotel`,
  test: `postgresql://hotel_test:${testDbPassword}@127.0.0.1:${postgresPort}/hotel`,
};
const generated = {
  POSTGRES_PASSWORD: ownerPassword,
  REDIS_PASSWORD: redisPassword,
  KEYCLOAK_DB_PASSWORD: randomBytes(24).toString('hex'),
  KEYCLOAK_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  HOTEL_API_DB_PASSWORD: apiDbPassword,
  HOTEL_WORKER_DB_PASSWORD: workerDbPassword,
  HOTEL_TEST_DB_PASSWORD: testDbPassword,
  DATABASE_URL: urls.owner,
  MIGRATION_DATABASE_URL: urls.owner,
  API_DATABASE_URL: urls.api,
  WORKER_DATABASE_URL: urls.worker,
  TEST_DATABASE_URL: urls.test,
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:56379/0`,
  KEYCLOAK_CLIENT_SECRET: randomBytes(24).toString('hex'),
  KEYCLOAK_TEST_USER_PASSWORD: `local-${randomBytes(12).toString('hex')}`,
  KEYCLOAK_MFA_USER_PASSWORD: `local-${randomBytes(12).toString('hex')}`,
  KEYCLOAK_MFA_TOTP_KEY: localKey(),
  KEYCLOAK_ADMIN_TOTP_KEY: localKey(),
};
const template = readFileSync('.env.example', 'utf8');

function render(value) {
  return template
    .split('\n')
    .map((line) => {
      const key = line.split('=')[0];
      if (!key || line.startsWith('#')) return line;
      if (Object.hasOwn(value, key)) return `${key}=${value[key]}`;
      return line;
    })
    .join('\n');
}

if (!existsSync('.env')) {
  writeFileSync('.env', render(generated), { flag: 'wx', mode: 0o600 });
  console.log(
    'Created private local .env with generated role passwords and secrets. No credentials were printed.',
  );
} else {
  const current = readFileSync('.env', 'utf8');
  const present = new Set(
    current
      .split('\n')
      .map((line) => line.split('=')[0]?.trim())
      .filter(Boolean),
  );
  const additions = template
    .split('\n')
    .filter((line) => {
      const key = line.split('=')[0]?.trim();
      return key && !present.has(key);
    })
    .map((line) => {
      const key = line.split('=')[0]?.trim();
      return Object.hasOwn(generated, key) ? `${key}=${generated[key]}` : line;
    });
  if (additions.length === 0) {
    console.log('.env already contains every documented key; left unchanged.');
  } else {
    writeFileSync('.env', `${current.trimEnd()}\n${additions.join('\n')}\n`, {
      mode: 0o600,
    });
    console.log(
      `Added ${additions.length} missing local configuration keys. Existing values were preserved and no credentials were printed.`,
    );
  }
}
