import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
function totp(key, now = Date.now()) {
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
async function freshTotp(key) {
  for (;;) {
    const remaining = 30000 - (Date.now() % 30000);
    if (remaining > 6000) return totp(key);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function waitNextWindow() {
  const remaining = 30000 - (Date.now() % 30000);
  await new Promise((resolve) => setTimeout(resolve, remaining + 800));
}
async function signIn(context, username, password, totpKey) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.click('a[href^="/api/v1/auth/login"]');
  await page.waitForURL(/\/realms\//, { timeout: 20000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  if (totpKey) {
    await page.waitForSelector('#otp', { timeout: 20000 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.fill('#otp', await freshTotp(totpKey));
      await page.click('#kc-login');
      await page.waitForTimeout(1500);
      if (!page.url().includes('/login-actions/authenticate')) break;
      await waitNextWindow();
    }
  }
  await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
    timeout: 20000,
  });
  return page;
}

const out = '.local/verification/PSR-02';
mkdirSync(out, { recursive: true });
const checks = [];
function check(name, condition) {
  checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
let writes = 0;
const errors = [];
try {
  const page = await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  page.on('pageerror', (error) => errors.push(error.message));
  const target = '11111111-1111-4111-8111-111111111111';
  let completed = false;
  await page.route('**/setup-draft', async (route) => {
    if (route.request().method() !== 'GET') {
      writes++;
      await route.abort();
      return;
    }
    await route.fulfill({
      json: {
        draft: {
          draft_id: '22222222-2222-4222-8222-222222222222',
          property_id: target,
          revision: 1,
          completed,
          updated_at: new Date().toISOString(),
          updated_by_user_id: null,
          input: completed
            ? { property: {}, unit_groups: [], operations: {} }
            : {
                schema_version: 2,
                property: {},
                locations: [],
                unit_groups: [],
                operations: {},
              },
        },
      },
    });
  });
  for (const locale of ['English', 'العربية']) {
    await page.goto(`${baseUrl}/preferences`);
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: locale, exact: true }).click();
    await page.waitForFunction(
      (lang) => document.documentElement.lang === lang,
      locale === 'English' ? 'en-US' : 'ar',
    );
    if (locale === 'العربية')
      await page.setViewportSize({ width: 390, height: 844 });
    for (const done of [false, true]) {
      completed = done;
      await page.goto(`${baseUrl}/setup-preview?propertyId=${target}`);
      await page.getByTestId('setup-read-only').waitFor();
      check(
        `${locale} ${done ? 'completed' : 'v2'} message`,
        (
          await page
            .getByTestId('setup-read-only')
            .getByRole('alert')
            .innerText()
        ).length > 20,
      );
      check(
        `${locale} ${done ? 'completed' : 'v2'} no edit/save controls`,
        (await page.getByTestId('save-draft').count()) === 0 &&
          (await page
            .getByTestId('setup-read-only')
            .getByRole('textbox')
            .count()) === 0,
      );
      check(
        `${locale} ${done ? 'completed' : 'v2'} no horizontal overflow`,
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: `${out}/readonly-${locale === 'English' ? 'en' : 'ar'}-${done ? 'completed' : 'v2'}.png`,
        fullPage: true,
      });
    }
  }
  check('no draft write attempted', writes === 0);
  check('no page errors', errors.length === 0);
  writeFileSync(
    `${out}/readonly-browser.json`,
    JSON.stringify(
      {
        checks,
        errors,
        writes,
        scope: 'UI-only mocked GET; PostgreSQL behavior covered separately',
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length}/${checks.length} readonly UI checks passed`);
} finally {
  await browser.close();
}
