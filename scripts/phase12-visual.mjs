import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

/**
 * P12-03 visual evidence (Playwright, declared exception as in P05..P11 — no
 * Computer Use in this environment): platform administration with minimum
 * customer data, the temporary-support grant lifecycle, usage/limits and audit,
 * Arabic RTL, 390px and the tenant-side boundary.
 */
const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const scope = 'P12-03';
const outDir = `.local/verification/${scope}`;
mkdirSync(outDir, { recursive: true });

const checks = [];
const failures = [];
const screenshots = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` | ${detail}` : ''}`,
  );
}
async function shot(page, name) {
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}
function bodyText(page) {
  return page
    .textContent('body')
    .then((text) => (text ?? '').replaceAll('\u00a0', ' '));
}
function totp(key, now = Date.now()) {
  const counter = BigInt(Math.floor(now / 30000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', Buffer.from(key, 'utf8'))
    .update(buffer)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}
let lastTotpWindow = 0;
async function freshTotp(key) {
  let now = Date.now();
  if (Math.floor(now / 30000) === lastTotpWindow) {
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    now = Date.now();
  }
  lastTotpWindow = Math.floor(now / 30000);
  return totp(key, now);
}

async function signIn(context, username, password, totpKey) {
  let lastError = null;
  for (let round = 0; round < 3; round += 1) {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('a[href^="/api/v1/auth/login"]');
      await page.waitForURL(/\/realms\//, { timeout: 30000 });
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('#kc-login');
      if (totpKey) {
        await page.waitForSelector('#otp', { timeout: 30000 });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await page.fill('#otp', await freshTotp(totpKey));
          await page.click('#kc-login');
          await page.waitForTimeout(1500);
          if (!page.url().includes('/login-actions/authenticate')) break;
        }
      }
      await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
        timeout: 30000,
      });
      return page;
    } catch (error) {
      lastError = error;
      await page.close().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError ?? new Error('sign-in failed');
}

async function setLanguage(page, optionName) {
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: optionName }).click();
  await page.waitForTimeout(800);
}

async function api(page, method, path, body) {
  const cookies = await page.context().cookies(apiUrl);
  const csrf = cookies.find((cookie) => cookie.name === 'hotel_csrf');
  const headers = {
    origin: baseUrl,
    'content-type': 'application/json',
    ...(csrf ? { 'x-csrf-token': csrf.value } : {}),
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    headers['idempotency-key'] = randomUUID();
  const response = await page.request.fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers,
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status(), body: data };
}

const runId = String(Date.now()).slice(-6);
const planCode = `P12VIS_${runId}`;
const slug = `p12-visual-${runId}`;
const customerLabel = `P12 Visual ${runId}`;

const pageErrors = [];
const consoleErrors = [];

const dbEvidence = {};
let context;
let ownerContext;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await signIn(
    context,
    'platform-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_PLATFORM_TOTP_KEY,
  );
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await setLanguage(page, /English/);

  // Synthetic fixtures through the platform contract itself.
  const plan = await api(page, 'POST', '/platform/plans', {
    code: planCode,
    name: `P12 visual plan ${runId}`,
  });
  check(
    'platform plan fixture created',
    plan.status === 201,
    String(plan.status),
  );
  const version = await api(
    page,
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      effective_from: new Date().toISOString().slice(0, 10),
      limits: { PROPERTIES: 2, API_CALLS: 10 },
      entitlements: { REPORTING: true },
      notes: 'synthetic visual policy',
    },
  );
  check(
    'platform policy version fixture created',
    version.status === 201,
    String(version.status),
  );
  const onboard = await api(page, 'POST', '/platform/tenants', {
    name: `P12 Visual Tenant ${runId}`,
    slug,
    customer_label: customerLabel,
    plan_code: planCode,
    reason: 'synthetic visual onboarding',
  });
  check(
    'visual tenant onboarded',
    onboard.status === 201,
    String(onboard.status),
  );
  const tenantId = onboard.body?.tenant_id;

  await page.goto(`${baseUrl}/platform`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('platform-tenants-table').waitFor({ timeout: 20000 });
  const directoryText = await bodyText(page);
  check(
    'platform directory renders minimum customer data',
    directoryText.includes(customerLabel),
  );
  check(
    'plan and usage limits are visible',
    directoryText.includes(`${planCode} v1`) &&
      directoryText.includes('PROPERTIES: 0/2'),
  );
  check(
    'no tenant name leaks into the platform directory',
    !directoryText.includes('P04 Synthetic Tenant A'),
  );
  const auditTable = await page.getByTestId('platform-audit-table').count();
  check('platform audit table is rendered', auditTable === 1);
  await shot(page, 'platform-directory-en');

  const row = page.locator('tr', { hasText: customerLabel });
  // Suspend through the console.
  await row.getByRole('button', { name: 'Suspend' }).click();
  await page.getByLabel('Reason').fill('synthetic visual suspension');
  await shot(page, 'platform-suspend-dialog');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(1200);
  const afterSuspend = await bodyText(page);
  check(
    'tenant suspended from the console',
    afterSuspend.includes('Suspended'),
  );
  check(
    'commitments-preserving notice shown',
    afterSuspend.includes('commitments preserved'),
  );

  // Reactivate through the console.
  await row.getByRole('button', { name: 'Reactivate' }).click();
  await page.getByLabel('Reason').fill('synthetic visual reactivation');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(1200);
  const afterReactivate = await bodyText(page);
  check(
    'tenant reactivated from the console',
    afterReactivate.includes('Active'),
  );

  // Support grant lifecycle through the console.
  await row.click();
  await page.getByRole('button', { name: 'Create support grant' }).click();
  await page.getByLabel('Support staff email').fill('platform-s@local.test');
  await page.getByLabel('Duration (minutes)').fill('30');
  await page.getByLabel('Reason').fill('synthetic visual support window');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(1200);
  const afterGrant = await bodyText(page);
  check(
    'support grant created and audited',
    afterGrant.includes('platform-s@local.test') &&
      afterGrant.includes('Active'),
  );
  await shot(page, 'platform-support-grants-en');

  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await page.waitForTimeout(1200);
  const afterRevoke = await bodyText(page);
  check('support grant revoked', afterRevoke.includes('Revoked'));

  await page
    .getByRole('button', { name: 'Read customer profile (with grant)' })
    .click();
  await page.waitForTimeout(1200);
  const supportResult = await page
    .getByTestId('platform-support-result')
    .textContent();
  check(
    'support read without a grant fails closed',
    (supportResult ?? '').toLowerCase().includes('grant'),
    String(supportResult),
  );

  // Arabic RTL and mobile width.
  await setLanguage(page, /العربية/);
  await page.goto(`${baseUrl}/platform`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('platform-page').waitFor({ timeout: 20000 });
  check(
    'platform console renders Arabic RTL',
    await page.evaluate(
      () => document.documentElement.getAttribute('dir') === 'rtl',
    ),
  );
  await shot(page, 'platform-ar-rtl');
  await setLanguage(page, /English/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/platform`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('platform-page').waitFor({ timeout: 20000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(
    'no horizontal overflow at 390px',
    overflow <= 1,
    `overflow=${overflow}`,
  );
  await shot(page, 'platform-mobile-390');

  // Tenant side boundary: no platform console at all.
  ownerContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const ownerPage = await signIn(
    ownerContext,
    'owner-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await ownerPage.goto(`${baseUrl}/platform`, {
    waitUntil: 'domcontentloaded',
  });
  await ownerPage.waitForTimeout(1200);
  const ownerForbidden = await ownerPage
    .getByTestId('platform-forbidden')
    .count();
  const ownerBody = await bodyText(ownerPage);
  check('tenant user sees no platform console', ownerForbidden === 1);
  check(
    'tenant sidebar has no platform entry',
    !ownerBody.includes('SaaS platform'),
  );
  await shot(ownerPage, 'platform-tenant-forbidden');

  // The fail-closed probes intentionally receive 403 responses; browsers log
  // those as resource-load errors, so they are reported but not counted as
  // unexpected console errors.
  const unexpectedConsoleErrors = consoleErrors.filter(
    (entry) => !/Failed to load resource.*403/.test(entry),
  );
  check(
    'no page or console errors during the visual run',
    pageErrors.length === 0 && unexpectedConsoleErrors.length === 0,
    JSON.stringify({ pageErrors, unexpectedConsoleErrors }),
  );

  // Database truth for the visual tenant.
  if (process.env.DATABASE_URL && tenantId) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const subscription = await client.query(
        `select "tenant_slug", "state", "version", "plan_code"
           from "platform_subscription" where "tenant_id" = $1`,
        [tenantId],
      );
      const lifecycle = await client.query(
        `select "event_type", "state_after" from "platform_lifecycle_event"
          where "tenant_id" = $1 order by "created_at"`,
        [tenantId],
      );
      const grants = await client.query(
        `select case
                  when "revoked_at" is not null then 'REVOKED'
                  when "expires_at" <= now() then 'EXPIRED'
                  else 'ACTIVE'
                end as "status"
           from "platform_support_grant"
          where "tenant_id" = $1`,
        [tenantId],
      );
      const audit = await client.query(
        `select count(*)::int as "count" from "platform_audit_event"
          where "tenant_id" = $1`,
        [tenantId],
      );
      dbEvidence.subscription = subscription.rows[0] ?? null;
      dbEvidence.lifecycle = lifecycle.rows.map((entry) => entry.event_type);
      dbEvidence.grants = grants.rows.map((entry) => entry.status);
      dbEvidence.platform_audit_events = audit.rows[0]?.count ?? 0;
      check(
        'database shows onboarded/suspended/reactivated history and revoked grant',
        dbEvidence.lifecycle.join(',') === 'ONBOARDED,SUSPENDED,REACTIVATED' &&
          dbEvidence.grants.includes('REVOKED'),
        JSON.stringify(dbEvidence),
      );
    } finally {
      await client.end();
    }
  }
} catch (error) {
  check('visual run completed without throwing', false, String(error));
} finally {
  const report = {
    scope,
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: 'chromium',
    engine: 'playwright',
    exception: 'Playwright declared exception P05..P12; no Computer Use',
    checks,
    failures,
    screenshots,
    page_errors: pageErrors,
    console_errors: consoleErrors,
    db_evidence: dbEvidence,
  };
  writeFileSync(
    `${outDir}/report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    `${outDir}/db-evidence.json`,
    `${JSON.stringify(dbEvidence, null, 2)}\n`,
  );
  await ownerContext?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  console.log(
    `visual:phase12 ${checks.filter((entry) => entry.ok).length}/${checks.length} checks, ${screenshots.length} screenshots`,
  );
  if (failures.length > 0) process.exitCode = 1;
}
