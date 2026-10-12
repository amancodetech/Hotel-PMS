import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = '.local/verification/PSR-06.3';
mkdirSync(out, { recursive: true });
const checks = [];
const errors = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};

function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8'))
    .update(buffer)
    .digest();
  const offset = digest[19] & 15;
  const value =
    (((digest[offset] & 127) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    1000000;
  return String(value).padStart(6, '0');
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.click('a[href^="/api/v1/auth/login"]');
  await page.waitForURL(/\/realms\//);
  await page.fill('#username', 'admin-a');
  await page.fill('#password', process.env.KEYCLOAK_TEST_USER_PASSWORD);
  await page.click('#kc-login');
  await page.waitForSelector('#otp');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!page.url().includes('/login-actions/authenticate')) break;
    await page.fill('#otp', totp(process.env.KEYCLOAK_ADMIN_TOTP_KEY));
    await page.click('#kc-login');
    try {
      await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
        timeout: 6000,
      });
      break;
    } catch {
      await page.waitForTimeout(30000 - (Date.now() % 30000) + 600);
    }
  }
  await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')));
  return page;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await signIn(context);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/preferences`);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  const fixture = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const tenant = session.session.active_tenant_id;
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const create = async (path, body, extra = {}) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          ...extra,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(`Fixture ${path}: ${r.status}`);
      return r.json();
    };
    const property = (
      await create(`/api/v1/tenants/${tenant}/properties`, {
        code: `ARC-${Date.now()}`,
        name: 'Synthetic archive browser fixture',
        timezone: 'Asia/Makassar',
      })
    ).property;
    const base = `/api/v1/tenants/${tenant}/properties/${property.id}`;
    const place = async (code, name) =>
      (
        await create(
          `${base}/locations`,
          { code, name, kind: 'BUILDING' },
          { 'idempotency-key': window.crypto.randomUUID() },
        )
      ).location;
    const used = await place('USED', 'Occupied synthetic place');
    const empty = await place('EMPTY', 'Empty synthetic place');
    const room = (
      await create(`${base}/resources`, {
        code: 'ARC-ROOM',
        type: 'ROOM',
        capacity: 2,
        display_label: 'Synthetic archive room',
        location_id: used.id,
      })
    ).resource;
    return { property, base, used, empty, room };
  });
  const openProperty = async () => {
    await page.goto(`${baseUrl}/properties/${fixture.property.id}`);
    await page.getByRole('tab', { name: 'Locations', exact: true }).waitFor();
  };
  await openProperty();
  const usedRow = page
    .getByRole('row')
    .filter({ hasText: 'Occupied synthetic place' });
  await usedRow.getByRole('button', { name: 'Archive', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByText('Units still use this place', { exact: true })
    .waitFor();
  check(
    'occupied location has a clear reason and disabled archive confirmation',
    await dialog.getByRole('button', { name: 'Confirm archive' }).isDisabled(),
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  check('keyboard Escape closes the preview', true);
  const emptyRow = page
    .getByRole('row')
    .filter({ hasText: 'Empty synthetic place' });
  await emptyRow.getByRole('button', { name: 'Archive', exact: true }).focus();
  await page.keyboard.press('Enter');
  dialog = page.getByRole('dialog');
  const confirmation = dialog.getByRole('button', { name: 'Confirm archive' });
  await confirmation.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] button')].some(
      (b) => b.textContent === 'Confirm archive' && !b.disabled,
    ),
  );
  await confirmation.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await page
    .getByRole('row')
    .filter({ hasText: 'Empty synthetic place' })
    .getByText('Inactive', { exact: true })
    .waitFor();
  const locations = await page.evaluate(
    async (base) => (await (await fetch(`${base}/locations`)).json()).items,
    fixture.base,
  );
  check(
    'empty location archives through keyboard and stays archived after reload with the same ID',
    locations.some((l) => l.id === fixture.empty.id && l.status === 'INACTIVE'),
  );
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  const roomRow = page.getByRole('row').filter({ hasText: 'ARC-ROOM' });
  await roomRow.getByRole('button', { name: 'Archive', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByText('This item can be archived. Its history will be kept.', {
      exact: true,
    })
    .waitFor();
  await dialog.getByRole('button', { name: 'Confirm archive' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'ARC-ROOM' })
    .getByText('Retired', { exact: true })
    .waitFor();
  const resources = await page.evaluate(
    async (base) => (await (await fetch(`${base}/resources`)).json()).items,
    fixture.base,
  );
  check(
    'unit retirement is saved and the same resource remains after reload',
    resources.some(
      (r) =>
        r.id === fixture.room.id &&
        r.state === 'RETIRED' &&
        r.location_id === fixture.used.id,
    ),
  );
  await page.goto(`${baseUrl}/preferences`);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/properties/${fixture.property.id}`);
  await page
    .getByRole('row')
    .filter({ hasText: 'Occupied synthetic place' })
    .getByRole('button', { name: 'أرشفة', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('توجد وحدات في هذا المكان', { exact: true }).waitFor();
  const geometry = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: window.innerWidth,
      overflow: el.scrollWidth - el.clientWidth,
    };
  });
  check(
    'Arabic preview keeps its blockers and critical controls within 390px',
    geometry.left >= 0 &&
      geometry.right <= geometry.width &&
      geometry.overflow <= 1 &&
      (await dialog
        .getByRole('button', { name: 'تأكيد الأرشفة', exact: true })
        .isDisabled()),
  );
  await dialog
    .getByRole('button', { name: 'تحديث المعاينة', exact: true })
    .click();
  await dialog.getByText('توجد وحدات في هذا المكان', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/archive-ar-390.png`, fullPage: true });
  check('no browser page errors', errors.length === 0);
  writeFileSync(
    `${out}/browser.json`,
    JSON.stringify({ checks, errors, fixture, geometry }, null, 2),
  );
  console.log(`PSR06.3 archive browser: ${checks.length}/${checks.length}`);
} finally {
  await browser.close();
}
