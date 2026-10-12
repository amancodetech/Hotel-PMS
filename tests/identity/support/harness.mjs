import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';
import { chromium, request } from 'playwright';
import { createHmac, randomUUID } from 'node:crypto';

const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl)
  throw new Error('DATABASE_URL required; run through pnpm test:identity');

export const testDatabaseUrl = (() => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL required');
  const url = new URL(base);
  url.pathname = `/${process.env.IDENTITY_TEST_DB}`;
  return url.toString();
})();

export const apiUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4100}`;
export const issuer = process.env.KEYCLOAK_ISSUER;
export const webOrigin = `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`;

export function totp(key, now = Date.now()) {
  const counter = BigInt(Math.floor(now / 30000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', Buffer.from(key, 'utf8'))
    .update(buffer)
    .digest();
  const offset = hmac[19] & 15;
  const code =
    (((hmac[offset] & 127) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1000000;
  return String(code).padStart(6, '0');
}

const usedWindows = new Map();
export async function freshTotp(username, key) {
  for (;;) {
    const current = Math.floor(Date.now() / 30000);
    const remaining = 30000 - (Date.now() % 30000);
    if (usedWindows.get(username) !== current && remaining > 5000) {
      usedWindows.set(username, current);
      return totp(key, Date.now());
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

let browser;
export async function getBrowser() {
  browser ??= await chromium.launch({ headless: true });
  return browser;
}

export async function closeBrowser() {
  await browser?.close();
  browser = undefined;
}

const sessionCacheTtlMs = 15 * 60 * 1000;

// Session caching is only active for shared-API runs (`pnpm test:property`);
// the per-suite API/identity runs keep the exact historical behavior.
function sessionCacheEnabled() {
  return (
    process.env.HARNESS_SHARED_API === '1' &&
    process.env.HARNESS_SESSION_CACHE !== 'off' &&
    process.env.HARNESS_SESSION_CACHE !== '0'
  );
}

function sessionCacheDirectory() {
  const configured = process.env.HARNESS_SESSION_CACHE;
  return configured && configured !== 'off' && configured !== '0'
    ? configured
    : '.local/harness-sessions';
}

function sessionCachePath(username) {
  const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${sessionCacheDirectory()}/${safe}.json`;
}

function readCachedSession(username) {
  try {
    const entry = JSON.parse(readFileSync(sessionCachePath(username), 'utf8'));
    if (entry.username !== username) return null;
    if (entry.database !== (process.env.IDENTITY_TEST_DB ?? null)) return null;
    if (typeof entry.savedAt !== 'number') return null;
    if (Date.now() - entry.savedAt >= sessionCacheTtlMs) return null;
    return entry.storageState ? entry : null;
  } catch {
    return null;
  }
}

function writeCachedSession(username, storageState) {
  if (!sessionCacheEnabled()) return;
  try {
    mkdirSync(sessionCacheDirectory(), { recursive: true, mode: 0o700 });
    const path = sessionCachePath(username);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        username,
        database: process.env.IDENTITY_TEST_DB ?? null,
        savedAt: Date.now(),
        storageState,
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    /* Session caching is an optimization; it never fails a suite. */
  }
}

function dropCachedSession(username) {
  try {
    unlinkSync(sessionCachePath(username));
  } catch {
    /* Already gone. */
  }
}

async function disposeContext(context) {
  if (typeof context.dispose === 'function') await context.dispose();
  else await context.close();
}

async function contextCookies(context) {
  if (typeof context.cookies === 'function') return context.cookies(apiUrl);
  const snapshot = await context.storageState();
  return snapshot.cookies ?? [];
}

async function cachedLogin(username) {
  if (!sessionCacheEnabled()) return null;
  const entry = readCachedSession(username);
  if (!entry) return null;
  const context = await request.newContext({
    storageState: entry.storageState,
  });
  const session = await apiRequest(context, 'GET', '/auth/session').catch(
    () => null,
  );
  if (session?.status === 200 && session.body?.authenticated)
    return { context, session };
  await disposeContext(context);
  dropCachedSession(username);
  return null;
}

const sessions = new Map();
export async function loginAs(username) {
  if (sessions.has(username)) return sessions.get(username);
  const entry = await loginFresh(username);
  sessions.set(username, entry);
  return entry;
}

export async function loginFresh(username) {
  const accounts = {
    'owner-a': {
      password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
    },
    'admin-a': {
      password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
      totpKey: process.env.KEYCLOAK_ADMIN_TOTP_KEY,
    },
    'member-a': { password: process.env.KEYCLOAK_TEST_USER_PASSWORD },
    'auditor-a': { password: process.env.KEYCLOAK_TEST_USER_PASSWORD },
    'owner-b': { password: process.env.KEYCLOAK_TEST_USER_PASSWORD },
    'mfa-a': {
      password: process.env.KEYCLOAK_MFA_USER_PASSWORD,
      totpKey: process.env.KEYCLOAK_MFA_TOTP_KEY,
    },
    'platform-a': {
      password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
      totpKey: process.env.KEYCLOAK_PLATFORM_TOTP_KEY,
    },
    'platform-b': {
      password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
    },
    'platform-s': {
      password: process.env.KEYCLOAK_TEST_USER_PASSWORD,
      totpKey: process.env.KEYCLOAK_PLATFORM_TOTP_KEY,
    },
  };
  const account = accounts[username];
  if (!account) throw new Error(`Unknown synthetic account ${username}`);
  const cached = await cachedLogin(username);
  if (cached) return cached;
  const activeBrowser = await getBrowser();
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  await page.goto(`${apiUrl}/api/v1/auth/login`, {
    waitUntil: 'domcontentloaded',
  });
  await page.fill('#username', username);
  await page.fill('#password', account.password);
  await page.click('#kc-login');
  if (account.totpKey) {
    await page.waitForSelector('#otp', { timeout: 20000 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.fill('#otp', await freshTotp(username, account.totpKey));
      await page.click('#kc-login');
      await page.waitForTimeout(1500);
      if (!page.url().includes('/login-actions/authenticate')) break;
      const remaining = 30000 - (Date.now() % 30000);
      await new Promise((resolve) => setTimeout(resolve, remaining + 800));
    }
  }
  // The browser may land on the web origin; tests only need the API session,
  // so poll the session endpoint instead of requiring the Vite server.
  const deadline = Date.now() + 30000;
  let session = null;
  while (Date.now() < deadline) {
    const response = await apiRequest(context, 'GET', '/auth/session').catch(
      () => null,
    );
    if (response?.body?.authenticated) {
      session = response;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await page.close();
  if (!session) throw new Error(`Login did not complete for ${username}`);
  writeCachedSession(username, await context.storageState());
  return { context, session };
}

export async function closeSessions() {
  for (const { context } of sessions.values()) await disposeContext(context);
  sessions.clear();
}

const idempotentRequestPaths = [
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/drafts$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservation-items\/[^/]+\/cancel$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/assignments$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-in$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/move$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/extend$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/split$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/early-departure$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/partial-departure$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-out$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/imports$/,
  /^\/tenants\/[^/]+\/guests$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/night-audits$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/folios$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/charges$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/charges\/[^/]+\/allocations$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/folios\/[^/]+\/charge-schedules$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/charge-schedules\/[^/]+\/post$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/folios\/[^/]+\/packages$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/package-entitlements\/[^/]+\/consumptions$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/folios\/[^/]+\/deposits$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/deposits\/[^/]+\/applications$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/deposits\/[^/]+\/releases$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/payments$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/payments\/[^/]+\/reconcile$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/payments\/[^/]+\/refunds$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/refunds\/[^/]+\/resolve$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/charges\/[^/]+\/reversal$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/charges\/[^/]+\/adjustments$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/fx-snapshots$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/fx-snapshots\/requests$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/invoices$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/invoices\/[^/]+\/credit-notes$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/cashier-sessions$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/cashier-sessions\/[^/]+\/count$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/cashier-sessions\/[^/]+\/close$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/clearance$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/tasks$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/assign$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/start$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/complete$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/inspect$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/dnd-logs$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/dnd-logs\/[^/]+\/follow-up$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/operations-policy$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/work-orders$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/assign$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/transitions$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/close$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/reopen$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/shift-handovers$/,
  /^\/tenants\/[^/]+\/properties\/[^/]+\/notifications\/[^/]+\/read$/,
];

export async function apiRequest(context, method, path, options = {}) {
  const headers = { origin: webOrigin, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (
    ['POST', 'PATCH'].includes(method) &&
    options.idempotency !== false &&
    headers['idempotency-key'] === undefined &&
    idempotentRequestPaths.some((pattern) => pattern.test(path))
  ) {
    headers['idempotency-key'] = randomUUID();
  }
  if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    options.csrf !== false &&
    !headers['x-csrf-token']
  ) {
    const cookie = (await contextCookies(context)).find(
      (entry) => entry.name === 'hotel_csrf',
    );
    if (cookie) headers['x-csrf-token'] = cookie.value;
  }
  const requestContext =
    typeof context.request?.fetch === 'function' ? context.request : context;
  const response = await requestContext.fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { data: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status(), body: data, headers: response.headers() };
}

export const testOwnerUrl = (() => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? ownerUrl);
  url.pathname = `/${process.env.IDENTITY_TEST_DB}`;
  return url.toString();
})();

export async function withOwner(task) {
  const client = new Client({ connectionString: testOwnerUrl });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

export async function withRuntimeRole(role, task) {
  const base =
    role === 'worker'
      ? process.env.WORKER_DATABASE_URL
      : process.env.API_DATABASE_URL;
  const url = new URL(base);
  url.pathname = `/${process.env.IDENTITY_TEST_DB}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

export async function withTestRole(task) {
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

export function readIdentityUsers() {
  return JSON.parse(readFileSync('.local/identity-users.json', 'utf8'));
}

export const state = {
  apiProcess: null,
  apiBorrowed: false,
};

export function apiDatabaseUrl() {
  const url = new URL(process.env.API_DATABASE_URL);
  url.pathname = `/${process.env.IDENTITY_TEST_DB}`;
  return url.toString();
}

export function workerDatabaseUrl() {
  const url = new URL(process.env.WORKER_DATABASE_URL);
  url.pathname = `/${process.env.IDENTITY_TEST_DB}`;
  return url.toString();
}

export async function startApi() {
  const { spawn } = await import('node:child_process');
  const { mkdirSync, appendFileSync } = await import('node:fs');
  if (process.env.HARNESS_SHARED_API === '1') {
    const response = await fetch(`${apiUrl}/api/v1/system/ready`).catch(
      () => null,
    );
    if (response?.status === 200) {
      state.apiBorrowed = true;
      state.apiLogPath = process.env.HARNESS_API_LOG ?? null;
      return { borrowed: true, logPath: state.apiLogPath };
    }
    throw new Error(
      `HARNESS_SHARED_API=1 but no API is ready at ${apiUrl}; run through pnpm test:property`,
    );
  }
  // Fail closed when another API already owns the port: the suite must run
  // against the API started with this test database, never a stale instance.
  const preflight = await fetch(`${apiUrl}/api/v1/system/ready`).catch(
    () => null,
  );
  if (preflight?.status === 200)
    throw new Error(
      `An API is already bound to ${apiUrl}; stop it first (pnpm dev:stop, pnpm api:stop or kill the orphan)`,
    );
  const logPath =
    process.env.HARNESS_API_LOG ??
    '.local/verification/P03-06/identity-api.log';
  const logDirectory = logPath.slice(0, logPath.lastIndexOf('/'));
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  appendFileSync(logPath, `\n--- api start ${new Date().toISOString()} ---\n`, {
    mode: 0o600,
  });
  const child = spawn(
    process.execPath,
    ['--env-file=.env', 'apps/api/dist/main.js'],
    {
      env: {
        ...process.env,
        API_DATABASE_URL: apiDatabaseUrl(),
        WORKER_DATABASE_URL: workerDatabaseUrl(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.apiOutput = '';
  child.stdout.on('data', (chunk) => {
    state.apiOutput += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    state.apiOutput += String(chunk);
  });
  state.apiProcess = child;
  state.apiLogPath = logPath;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(
        `API process exited before becoming ready (exit ${child.exitCode}); is another API already bound to ${apiUrl}?`,
      );
    if (Date.now() > deadline) {
      await stopApi();
      throw new Error(
        `API did not become ready: ${state.apiOutput.slice(-400)}`,
      );
    }
    try {
      const response = await fetch(`${apiUrl}/api/v1/system/ready`);
      if (response.status === 200) break;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  appendFileSync(logPath, state.apiOutput, { mode: 0o600 });
  return { logPath };
}
export async function stopApi() {
  const { appendFileSync } = await import('node:fs');
  if (state.apiBorrowed) {
    state.apiBorrowed = false;
    state.apiLogPath = null;
    return;
  }
  const child = state.apiProcess;
  state.apiProcess = null;
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (state.apiLogPath)
    appendFileSync(state.apiLogPath, state.apiOutput ?? '', { mode: 0o600 });
}
