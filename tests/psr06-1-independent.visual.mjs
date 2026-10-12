import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = '.local/verification/PSR-06.1-independent';
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
  page.setDefaultTimeout(10000);
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
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          ...extra,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error(`Fixture ${path}: ${response.status}`);
      return response.json();
    };
    const code = `PSR06-${Date.now()}`;
    const property = (
      await create(`/api/v1/tenants/${tenant}/properties`, {
        code,
        name: 'PSR06 synthetic edit fixture',
        timezone: 'Asia/Makassar',
      })
    ).property;
    const base = `/api/v1/tenants/${tenant}/properties/${property.id}`;
    const location = async (code, name) =>
      (
        await create(
          `${base}/locations`,
          { code, name, kind: 'BUILDING' },
          { 'idempotency-key': window.crypto.randomUUID() },
        )
      ).location;
    const original = await location('WEST', 'West wing');
    const destination = await location('EAST', 'East wing');
    const resource = (
      await create(`${base}/resources`, {
        code: 'ROOM-101',
        type: 'ROOM',
        capacity: 2,
        display_label: 'Room 101',
        location_id: original.id,
      })
    ).resource;
    return { base, propertyId: property.id, original, destination, resource };
  });

  await page.goto(`${baseUrl}/properties/${fixture.propertyId}`);
  await page.getByRole('tab', { name: 'Resources' }).click();
  await page.getByText('West wing', { exact: true }).waitFor();
  const row = page.getByRole('row').filter({ hasText: 'ROOM-101' });
  await row
    .getByRole('button', { name: 'Edit unit name and location' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Unit name').fill('Garden Room 101');
  await dialog
    .getByText('East wing · EAST')
    .locator('..')
    .getByRole('button', { name: 'Use this place' })
    .click();
  await dialog.getByText('East wing', { exact: true }).waitFor();
  check(
    'editable name and destination selected',
    (await dialog.getByLabel('Unit name').inputValue()) === 'Garden Room 101',
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await row.getByText('Garden Room 101', { exact: true }).waitFor();
  await row.getByText('East wing', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('tab', { name: 'Resources' }).click();
  await row.getByText('Garden Room 101', { exact: true }).waitFor();
  await row.getByText('East wing', { exact: true }).waitFor();
  check(
    'edited name and place persist after reload',
    (await row.getByText('East wing', { exact: true }).count()) === 1,
  );
  const result = await page.evaluate(
    async (base) => (await (await fetch(`${base}/resources`)).json()).items,
    fixture.base,
  );
  check(
    'resource identity and code remain stable',
    result.length === 1 &&
      result[0].id === fixture.resource.id &&
      result[0].code === fixture.resource.code &&
      result[0].location_id === fixture.destination.id &&
      result[0].version === fixture.resource.version + 1,
  );

  const resourcePath = `${fixture.base}/resources/${fixture.resource.id}`;
  const readResource = async () =>
    page.evaluate(
      async (base) =>
        (await (await fetch(`${base}/resources`)).json()).items[0],
      fixture.base,
    );
  const openEditor = async () => {
    await row
      .getByRole('button', { name: 'Edit unit name and location' })
      .click();
    await dialog.waitFor();
  };
  await openEditor();
  await dialog.getByLabel('Unit name').fill('Kept after rejection');
  await page.route(`**${resourcePath}`, async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'CROSS_SCOPE_REFERENCE', details: {} }),
      });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  check(
    'rejected edit preserves input and keeps dialog open',
    (await dialog.getByLabel('Unit name').inputValue()) ===
      'Kept after rejection',
  );
  await page.unroute(`**${resourcePath}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  check(
    'retry after rejection commits saved input',
    (await readResource()).display_label === 'Kept after rejection',
  );

  const beforeLost = await readResource();
  await openEditor();
  await dialog.getByLabel('Unit name').fill('Committed despite lost response');
  await page.route(`**${resourcePath}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.unroute(`**${resourcePath}`);
  const afterLost = await readResource();
  check(
    'lost response readback recognizes one committed edit',
    afterLost.display_label === 'Committed despite lost response' &&
      afterLost.version === beforeLost.version + 1,
  );

  // This is a real server-side competing edit while the user keeps a stale dialog.
  await openEditor();
  await dialog.getByLabel('Unit name').fill('My pending edit');
  const competing = await page.evaluate(
    async ({ path, version }) => {
      const csrf = decodeURIComponent(
        document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
      );
      const response = await fetch(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ version, display_label: 'Other writer' }),
      });
      return response.status;
    },
    { path: resourcePath, version: afterLost.version },
  );
  assert.equal(competing, 200);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  check(
    'stale writer preserves typed input without overwriting winner',
    (await dialog.getByLabel('Unit name').inputValue()) === 'My pending edit' &&
      (await readResource()).display_label === 'Other writer',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await openEditor();
  check(
    'reopening editor loads latest version after conflict',
    (await dialog.getByLabel('Unit name').inputValue()) === 'Other writer',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const secondProperty = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const response = await fetch(
      `/api/v1/tenants/${session.session.active_tenant_id}/properties`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          code: `PSR061-B-${Date.now()}`,
          name: 'Independent second property',
          timezone: 'Asia/Makassar',
        }),
      },
    );
    if (!response.ok) throw Error(`second property ${response.status}`);
    return (await response.json()).property.id;
  });
  // Prime the second property cache so navigation does not happen to unmount via LoadingBlock.
  const navigate = async (id) =>
    page.evaluate((id) => {
      window.history.pushState({}, '', `/properties/${id}`);
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    }, id);
  await navigate(secondProperty);
  await page
    .getByRole('heading', { name: /Independent second property/ })
    .waitFor();
  await navigate(fixture.propertyId);
  await row.waitFor();
  await openEditor();
  await dialog.getByLabel('Unit name').fill('Must not leak');
  await navigate(secondProperty);
  await page
    .getByRole('heading', { name: /Independent second property/ })
    .waitFor();
  await dialog.waitFor({ state: 'hidden' });
  check(
    'cached property switch clears editor identity and draft text',
    (await page.getByRole('dialog').count()) === 0,
  );

  for (const locale of [
    {
      name: 'العربية',
      code: 'ar',
      dir: 'rtl',
      edit: 'تعديل اسم الوحدة وموقعها',
      tab: 'الموارد',
    },
    {
      name: 'Bahasa Indonesia',
      code: 'id-ID',
      dir: 'ltr',
      edit: 'Ubah nama dan lokasi unit',
      tab: 'Sumber daya',
    },
  ]) {
    await page.goto(`${baseUrl}/preferences`);
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: locale.name, exact: true }).click();
    await page.waitForFunction(
      (code) => document.documentElement.lang === code,
      locale.code,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/properties/${fixture.propertyId}`);
    await page.getByRole('tab').nth(1).click();
    await page.getByRole('button', { name: locale.edit }).click();
    await dialog.waitFor();
    const firstInput = dialog.locator('input').first();
    await firstInput.focus();
    await page.keyboard.press('Tab');
    const lastButton = dialog.getByRole('button').last();
    await lastButton.scrollIntoViewIfNeeded();
    const bounds = await lastButton.boundingBox();
    check(
      `${locale.code} mobile edit controls and direction`,
      (await page.locator('html').getAttribute('dir')) === locale.dir &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 390,
    );
    await page.screenshot({
      path: `${out}/edit-${locale.code}-mobile.png`,
      fullPage: true,
    });
  }
  check('no browser exceptions', errors.length === 0);
  await page.screenshot({ path: `${out}/edit-en.png`, fullPage: true });
  writeFileSync(
    `${out}/browser.json`,
    JSON.stringify({ checks, errors, fixture: fixture.propertyId }, null, 2),
  );
  console.log(
    `PSR-06.1 independent browser: ${checks.length}/${checks.length}`,
  );
} finally {
  await browser.close();
}
