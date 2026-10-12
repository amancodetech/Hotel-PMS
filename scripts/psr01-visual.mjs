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

const out = '.local/verification/PSR-01';
mkdirSync(out, { recursive: true });
const checks = [];
function check(name, condition) {
  checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
  console.log('PASS:', name);
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const errors = [];
let writes = 0;
try {
  const page = await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  await page.goto(`${baseUrl}/preferences`);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (
      /\/api\/.*(setup|properties)/.test(r.url()) &&
      !['GET', 'HEAD'].includes(r.method())
    )
      writes++;
  });
  await page.goto(`${baseUrl}/structure-preview`);
  await page
    .getByRole('heading', {
      level: 1,
      name: 'Property setup — new journey preview',
    })
    .waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  check(
    'required input focuses error',
    await page
      .locator('[role=alert][tabindex="-1"]')
      .evaluate((el) => document.activeElement === el),
  );
  await page
    .getByRole('button', { name: 'Example hotel', exact: true })
    .click();
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  check(
    'nineteen physical hotel units',
    await page.getByText('Physical units: 19', { exact: true }).isVisible(),
  );
  check(
    'nineteen individual options',
    await page
      .getByText('Accommodation options: 19', { exact: true })
      .isVisible(),
  );
  await page.screenshot({ path: `${out}/hotel-desktop.png`, fullPage: true });
  await page.goto(`${baseUrl}/structure-preview`);
  await page
    .getByRole('button', { name: 'Example private villa', exact: true })
    .click();
  for (let i = 0; i < 2; i++)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page
    .getByRole('radio', { name: 'Whole unit or separate rooms', exact: true })
    .check();
  await page
    .getByRole('textbox', {
      name: 'Separately rentable room names, one per line',
    })
    .fill('East\nWest');
  await page
    .getByRole('radio', { name: 'Whole unit only', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Keep current setup', exact: true })
    .click();
  check(
    'cancel preserves parts',
    (await page
      .getByRole('textbox', {
        name: 'Separately rentable room names, one per line',
      })
      .inputValue()) === 'East\nWest',
  );
  await page
    .getByRole('radio', { name: 'Whole unit only', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  check(
    'whole villa is one unit',
    await page.getByText('Physical units: 1', { exact: true }).isVisible(),
  );
  check(
    'descriptive bedrooms preserved',
    await page
      .getByText('Descriptive bedrooms: 4', { exact: true })
      .isVisible(),
  );
  await page
    .getByRole('button', { name: 'Finish prototype walkthrough' })
    .click();
  check(
    'no server save claim',
    await page
      .getByText(
        'Prototype walkthrough completed. No data was saved in the system.',
      )
      .isVisible(),
  );
  await page.goto(`${baseUrl}/preferences`);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.goto(`${baseUrl}/structure-preview`);
  await page
    .getByRole('button', { name: 'منتجع مختلط توضيحي', exact: true })
    .click();
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'mobile RTL units no horizontal overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: `${out}/mixed-mobile-rtl.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  check(
    'mixed has three separate groups',
    (await page.getByRole('heading', { level: 3 }).count()) === 3,
  );
  check(
    'review mobile no horizontal overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: `${out}/mixed-review-rtl.png`,
    fullPage: true,
  });
  check('no setup writes from prototype', writes === 0);
  check('no page exceptions', errors.length === 0);
} finally {
  writeFileSync(
    `${out}/browser-results.json`,
    JSON.stringify({ checks, errors, writes }, null, 2),
  );
  await browser.close();
}
