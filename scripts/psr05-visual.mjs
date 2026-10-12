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

const out = '.local/verification/PSR-05';
mkdirSync(out, { recursive: true });
const checks = [];
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const errors = [];
try {
  const page = await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseUrl + '/preferences');
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  const fixture = await page.evaluate(async () => {
    const s = await (await fetch('/api/v1/auth/session')).json();
    const tenant = s.session.active_tenant_id;
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const r = await fetch('/api/v1/tenants/' + tenant + '/properties', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        code: 'PSR05-' + Date.now(),
        name: 'PSR05 synthetic hotel',
        timezone: 'Asia/Makassar',
      }),
    });
    if (!r.ok) throw Error('fixture ' + r.status);
    return { tenant, id: (await r.json()).property.id };
  });
  await page.evaluate(async ({ tenant, id }) => {
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const create = async (code, name, parent_id, kind) => {
      const response = await fetch(
        `/api/v1/tenants/${tenant}/properties/${id}/locations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': window.crypto.randomUUID(),
          },
          body: JSON.stringify({
            code,
            name,
            parent_id,
            kind,
            display_order: 0,
          }),
        },
      );
      if (!response.ok) throw Error('location fixture ' + response.status);
      return (await response.json()).location.id;
    };
    const parent = await create('WEST', 'West building', null, 'BUILDING');
    await create('WEST-F1', 'First floor', parent, 'FLOOR');
  }, fixture);
  const url = baseUrl + '/properties/' + fixture.id + '/structure';
  await page.goto(url);
  await page
    .getByRole('button', { name: 'Browse children', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use this place', exact: true })
    .click();
  check(
    'existing nested place imported with ancestors',
    (await page.getByLabel('Place name', { exact: true }).count()) === 2,
  );
  await page.getByRole('button', { name: 'Add place', exact: true }).click();
  await page
    .getByLabel('Place name', { exact: true })
    .last()
    .fill('East building');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Add units', exact: true }).click();
  await page.getByLabel('Number range', { exact: true }).fill('101-102');
  await page
    .getByRole('link', { name: 'Open property management', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('You have unsaved changes. Leaving discards these edits.', {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  check(
    'internal navigation can be cancelled without losing edits',
    (await page.getByLabel('Number range', { exact: true }).inputValue()) ===
      '101-102',
  );
  await page.getByLabel('Guest capacity per unit', { exact: true }).fill('2');
  await page.getByLabel('Building or area (optional)', { exact: true }).click();
  await page
    .getByRole('option', { name: 'West building / First floor', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'editable mobile no overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({ path: out + '/units-mobile.png', fullPage: true });
  await page.keyboard.press('Tab');
  check(
    'keyboard focus remains on an interactive control',
    await page.evaluate(() =>
      ['INPUT', 'BUTTON', 'A'].includes(document.activeElement?.tagName),
    ),
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  let saveDropped = false;
  const saveKeys = [];
  await page.route('**/setup-draft', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    saveKeys.push(route.request().headers()['idempotency-key']);
    if (!saveDropped) {
      saveDropped = true;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Draft saved on the server.', { exact: true }).waitFor();
  check(
    'save retry preserves key',
    saveKeys.length === 2 && saveKeys[0] === saveKeys[1],
  );
  await page.reload();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  check(
    'saved range resumes',
    (await page.getByLabel('Number range', { exact: true }).inputValue()) ===
      '101-102',
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page
    .getByLabel('Set prices later — adding units alone does not open sales', {
      exact: true,
    })
    .uncheck();
  await page.getByLabel('Rate plan name', { exact: true }).fill('Standard');
  await page.getByLabel('Base nightly price', { exact: true }).fill('100000');
  const today = new Date();
  const from = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 3 * 86400000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel('Prices from', { exact: true }).fill(from);
  await page.getByLabel('Prices until (exclusive)', { exact: true }).fill(to);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByText('Draft saved on the server.', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Preview saved plan', exact: true })
    .click();
  await page
    .getByText('Unit and container records: 2', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  check(
    'review at 200 percent has no page overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
    window.scrollTo(0, 0);
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
  await page.screenshot({ path: out + '/preview-en.png', fullPage: true });
  check(
    'preview can apply',
    await page
      .getByRole('button', { name: 'Apply structure', exact: true })
      .isEnabled(),
  );
  await page
    .getByRole('button', { name: 'Apply structure', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm action', exact: true })
    .click();
  await page
    .getByText(
      'This setup is complete. Open property management for additions and changes.',
      { exact: true },
    )
    .waitFor();
  check(
    'completed save unavailable',
    (await page
      .getByRole('button', { name: 'Save draft', exact: true })
      .count()) === 0,
  );
  const resources = await page.evaluate(
    async ({ tenant, id }) =>
      (
        await (
          await fetch(
            '/api/v1/tenants/' + tenant + '/properties/' + id + '/resources',
          )
        ).json()
      ).items,
    fixture,
  );
  check('exactly two real resource rows', resources.length === 2);
  const plans = await page.evaluate(async ({ tenant, id }) => {
    const response = await fetch(
      `/api/v1/tenants/${tenant}/properties/${id}/rate-plans`,
    );
    if (!response.ok) throw Error('rate plans ' + response.status);
    return (await response.json()).items;
  }, fixture);
  check('pricing creates a plan for each exact unit', plans.length === 2);

  check(
    'units reference the selected location',
    resources.every((r) => Boolean(r.location_id)),
  );
  await page
    .getByRole('link', { name: 'Open property management', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await page
    .getByText('West building / First floor', { exact: true })
    .first()
    .waitFor();
  check(
    'unit table shows full location paths',
    (await page
      .getByText('West building / First floor', { exact: true })
      .count()) === 2,
  );
  const completedBefore = await page.evaluate(
    async ({ tenant, id }) =>
      (
        await (
          await fetch(`/api/v1/tenants/${tenant}/properties/${id}/setup-draft`)
        ).json()
      ).draft,
    fixture,
  );
  await page.getByRole('link', { name: 'Add new units', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Add new units', exact: true })
    .waitFor();
  check(
    'addition keeps property settings read only',
    await page.getByLabel(/^Property name/).isDisabled(),
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Add units', exact: true }).click();
  await page.getByLabel('Unit type', { exact: true }).click();
  await page.getByRole('option', { name: 'Villa', exact: true }).click();
  await page.getByLabel('Number range', { exact: true }).fill('201-201');
  await page.getByLabel('Guest capacity per unit', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Add units', exact: true }).click();
  await page.getByLabel('Unit type', { exact: true }).nth(1).click();
  await page.getByRole('option', { name: 'Tent', exact: true }).click();
  await page.getByLabel('Number range', { exact: true }).nth(1).fill('301-301');
  await page
    .getByLabel('Guest capacity per unit', { exact: true })
    .nth(1)
    .fill('2');
  check(
    'mixed unit groups keep independent types and capacities',
    (await page
      .getByLabel('Guest capacity per unit', { exact: true })
      .first()
      .inputValue()) === '4' &&
      (await page
        .getByLabel('Guest capacity per unit', { exact: true })
        .nth(1)
        .inputValue()) === '2',
  );
  await page
    .getByRole('button', { name: 'Remove this group', exact: true })
    .nth(1)
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm action', exact: true })
    .click();
  check(
    'removing one group preserves the other group',
    (await page.getByLabel('Number range', { exact: true }).inputValue()) ===
      '201-201',
  );

  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Booking method', { exact: true }).click();
  await page
    .getByRole('option', {
      name: 'Whole or rooms, with exclusive inventory',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Add separately rentable room', exact: true })
    .click();
  await page
    .getByLabel('Internal code (Latin letters and digits)', { exact: true })
    .fill('A');
  await page.getByLabel('Guest-facing name', { exact: true }).fill('Bedroom A');
  await page.getByLabel('Booking method', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Whole unit only', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('Add separately rentable room: Bedroom A', { exact: true })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm action', exact: true })
    .click();
  check(
    'mode-change dialog describes removed parts',
    (await page.getByLabel('Guest-facing name', { exact: true }).count()) === 0,
  );
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('Unit type', { exact: true }).click();
  await page
    .getByRole('option', { name: 'Connected-unit suite', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('201-201', { exact: true })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm action', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page
    .getByLabel('Select existing connected units', { exact: true })
    .click();
  await page.getByRole('option', { name: '101 · 101', exact: true }).click();
  await page.getByRole('option', { name: '102 · 102', exact: true }).click();
  await page.keyboard.press('Escape');
  await page
    .getByLabel('I confirm these units are physically connected', {
      exact: true,
    })
    .check();
  await page.getByLabel('Valid from', { exact: true }).fill(from);
  await page.getByLabel('Valid through (inclusive)', { exact: true }).fill(to);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preview addition', exact: true })
    .click();
  await page
    .getByText('Unit and container records: 0', { exact: true })
    .waitFor();
  check(
    'connected addition creates no physical rooms in preview',
    await page
      .getByRole('button', { name: 'Add these units', exact: true })
      .isEnabled(),
  );
  const additionKeys = [];
  await page.route('**/setup-unit-additions', async (route) => {
    additionKeys.push(route.request().headers()['idempotency-key']);
    if (additionKeys.length === 1) {
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await page
    .getByRole('button', { name: 'Add these units', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm action', exact: true })
    .click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page
    .getByText('Created 0 units and 1 accommodation options.', { exact: false })
    .waitFor();
  check(
    'addition replay after reload uses the same key',
    additionKeys.length === 2 && additionKeys[0] === additionKeys[1],
  );
  const completedAfter = await page.evaluate(
    async ({ tenant, id }) =>
      (
        await (
          await fetch(`/api/v1/tenants/${tenant}/properties/${id}/setup-draft`)
        ).json()
      ).draft,
    fixture,
  );
  check(
    'addition never reopens or edits completed draft',
    JSON.stringify(completedAfter) === JSON.stringify(completedBefore),
  );
  await page
    .getByRole('button', { name: 'Simulate a unit booking', exact: true })
    .click();
  await page.getByLabel('Product', { exact: true }).click();
  await page.getByRole('option').filter({ hasText: '101 + 102' }).click();
  await page.getByLabel('Arrival', { exact: true }).fill(from);
  await page.getByLabel('Departure', { exact: true }).fill(to);
  await page
    .getByRole('button', { name: 'Check availability', exact: true })
    .click();
  await page.getByText('Available', { exact: true }).waitFor();
  check(
    'server simulation resolves both connected rooms',
    (
      await page.getByText(/Units consumed by this booking/).textContent()
    ).includes('101') &&
      (
        await page.getByText(/Units consumed by this booking/).textContent()
      ).includes('102'),
  );
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
  await page.screenshot({
    path: out + '/addition-simulation.png',
    fullPage: true,
  });
  await page.goto(baseUrl + '/preferences');
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'ar');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page
    .getByRole('heading', { name: 'إعداد المنشأة', exact: true })
    .waitFor();
  check(
    'RTL mobile no horizontal overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: out + '/completed-ar-mobile.png',
    fullPage: true,
  });
  check('no browser exceptions', errors.length === 0);
  writeFileSync(
    out + '/browser.json',
    JSON.stringify({ checks, errors, fixture }, null, 2),
  );
  console.log(checks.length + ' checks passed');
} finally {
  await browser.close();
}
