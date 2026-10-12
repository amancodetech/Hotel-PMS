import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

/**
 * P11-03 visual evidence (Playwright, declared exception as in P05..P10 — no
 * Computer Use in this environment): the reports screen with declared units,
 * cutoff and lag, the private short-lived export lifecycle, Arabic RTL and
 * 390px.
 */
const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const scope = 'P11-03';
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
          await waitNextWindow();
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

const idempotentPaths = [
  /^\/api\/v1\/tenants\/[^/]+\/properties$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/resources$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products\/[^/]+\/candidates$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rate-plans$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rate-plans\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rates\/batch$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/quotes$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/drafts$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-in$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/folios$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/charges$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reports\/snapshots$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reports\/exports$/,
];
async function api(page, method, path, body) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'hotel_csrf')?.value;
  const headers = {
    'x-csrf-token': csrf ?? '',
    'content-type': 'application/json',
    origin: baseUrl,
  };
  if (
    ['POST', 'PUT', 'PATCH'].includes(method) &&
    idempotentPaths.some((pattern) => pattern.test(path))
  ) {
    headers['idempotency-key'] = randomUUID();
  }
  const response = await page.request.fetch(`${apiUrl}${path}`, {
    method,
    headers,
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status(),
    body: await response.json().catch(() => ({})),
  };
}
function todayIso() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
function shift(days) {
  const date = new Date(`${todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function withOwner(task) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}
async function dbRows(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}
async function overflow(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const documentElement = document.documentElement;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      let node = element.parentElement;
      let scrollable = false;
      while (node && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') scrollable = true;
        node = node.parentElement;
      }
      if (scrollable) continue;
      if (box.right > viewport + 1 || box.left < -1)
        offenders.push(element.tagName.toLowerCase());
    }
    return {
      documentDelta: documentElement.scrollWidth - documentElement.clientWidth,
      bodyDelta: document.body.scrollWidth - document.body.clientWidth,
      offenders: offenders.slice(0, 8),
    };
  });
}
async function setLanguage(page, optionName) {
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: optionName }).click();
  await page.waitForTimeout(800);
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const runId = String(Date.now()).slice(-6);
const today = todayIso();
const dbEvidence = {};
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const page = await context.newPage();
const ownerContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const ownerPage = await ownerContext.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

async function makeProperty(label) {
  const base = `/api/v1/tenants/${dbEvidence.tenantId}/properties`;
  const property = await api(page, 'POST', base, {
    code: `P11V-${label}-${runId}`,
    name: `Phase 11 visual ${label} ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  const propertyId = property.body.property.id;
  const rooms = [];
  for (let index = 1; index <= 3; index += 1) {
    const resource = await api(
      page,
      'POST',
      `${base}/${propertyId}/resources`,
      { code: `P11V-${label}-R${index}-${runId}`, type: 'ROOM', capacity: 2 },
    );
    rooms.push(resource.body.resource);
  }
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P11V-${label}-P-${runId}`,
    name: `Visual reports ${label}`,
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  const productId = product.body.product.id;
  for (const room of rooms) {
    await api(
      page,
      'POST',
      `${base}/${propertyId}/products/${productId}/candidates`,
      { resource_id: room.id },
    );
  }
  await api(page, 'PATCH', `${base}/${propertyId}/products/${productId}`, {
    version: product.body.product.version,
    status: 'ACTIVE',
  });
  const plan = await api(page, 'POST', `${base}/${propertyId}/rate-plans`, {
    code: `P11V-${label}-RP-${runId}`,
    name: `Visual reports plan ${label}`,
    product_id: productId,
    currency: 'IDR',
  });
  const planId = plan.body.rate_plan.id;
  await api(page, 'PATCH', `${base}/${propertyId}/rate-plans/${planId}`, {
    version: plan.body.rate_plan.version,
    status: 'ACTIVE',
  });
  const cells = [];
  for (let offset = 0; offset <= 5; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: shift(offset),
      occupancy: 2,
      money: { amount: '275000', currency: 'IDR' },
    });
  }
  await api(page, 'POST', `${base}/${propertyId}/rates/batch`, { cells });
  return { base, propertyId, rooms, productId, planId };
}

async function createRevenue(scopeInfo) {
  const { base, propertyId, productId, planId } = scopeInfo;
  const quote = await api(page, 'POST', `${base}/${propertyId}/quotes`, {
    product_id: productId,
    rate_plan_id: planId,
    period: { arrival: today, departure: shift(1) },
    occupancy: { adults: 2, child_ages: [] },
    quantity: 1,
  });
  const draft = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/drafts`,
    {
      source: 'DIRECT',
      items: [
        {
          product_id: productId,
          period: { arrival: today, departure: shift(1) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
    },
  );
  const reservationId = draft.body.reservation.id;
  const detail = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  const itemId = detail.body.items[0].id;
  const inventory = await api(
    page,
    'GET',
    `${base}/${propertyId}/rates?from=${today}&to=${shift(5)}`,
  );
  await api(page, 'POST', `${base}/${propertyId}/reservations`, {
    reservation_id: reservationId,
    inventory_version: inventory.body.inventory_version,
    items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
  });
  const folio = await api(page, 'POST', `${base}/${propertyId}/folios`, {
    reservation_id: reservationId,
    kind: 'GUEST',
    payer_label: `Visual report guest ${runId}`,
    currency: 'IDR',
  });
  if (folio.status !== 200) throw new Error(`folio ${folio.status}`);
  const day = await api(
    page,
    'GET',
    `${base}/${propertyId}/finance/business-day`,
  );
  const charge = await api(page, 'POST', `${base}/${propertyId}/charges`, {
    folio_id: folio.body.folio.id,
    business_date: day.body.date,
    money: { amount: '400000', currency: 'IDR' },
    tax_money: { amount: '40000', currency: 'IDR' },
    tax_policy: { code: 'SYNTHETIC' },
    account_code: 'REVENUE_ROOM',
    source_ref: `P11V-${runId}`,
  });
  if (charge.status !== 200) throw new Error(`charge ${charge.status}`);
  return { businessDate: day.body.date };
}

try {
  await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  await signIn(
    ownerContext,
    'owner-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await setLanguage(page, /English/);
  await setLanguage(ownerPage, /English/);
  const session = await api(page, 'GET', '/api/v1/auth/session');
  const tenantId = session.body.session?.active_tenant_id;
  dbEvidence.tenantId = tenantId;
  check('active tenant session', Boolean(tenantId), `tenant=${tenantId}`);

  const property = await makeProperty('MAIN');
  const revenue = await createRevenue(property);

  // Open the reports screen from the properties list.
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 15000 });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`P11V-MAIN-${runId}`);
  const propertyRow = page
    .locator('tbody tr')
    .filter({ hasText: `P11V-MAIN-${runId}` });
  await propertyRow.waitFor({ timeout: 15000 });
  await propertyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Reports' }).click();
  await page.waitForURL(/\/reports$/, { timeout: 15000 });
  await page
    .getByRole('button', { name: 'Run report' })
    .waitFor({ timeout: 20000 });
  check('PropertiesPage opens the reports screen', true, page.url());
  await shot(page, 'reports-idle');

  // Occupancy with declared units and denominators.
  await page.getByRole('button', { name: 'Run report' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Reserved resource-nights'),
    30000,
    'occupancy metrics',
  );
  const occupancyText = await bodyText(page);
  check(
    'occupancy shows declared units and denominators',
    occupancyText.includes('resource_night') &&
      occupancyText.includes('Physical') &&
      occupancyText.includes('Operational'),
  );
  check(
    'cutoff, timezone, data basis and lag are visible',
    occupancyText.includes('Cutoff') &&
      occupancyText.includes('Asia/Jakarta') &&
      occupancyText.includes('OPERATING_DB') &&
      occupancyText.includes('Lag'),
  );
  await shot(page, 'reports-occupancy');

  // Financial revenue through the same snapshot.
  await page.getByLabel('Report').click();
  await page.getByRole('option', { name: 'Revenue' }).click();
  await page.getByRole('button', { name: 'Run report' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Posted journal'),
    30000,
    'revenue metrics',
  );
  const revenueText = await bodyText(page);
  check(
    'revenue matches the posted journal amount',
    revenueText.includes('400000'),
    revenue.businessDate,
  );
  await shot(page, 'reports-revenue');

  // Private short-lived export: create, wait for READY, download, revoke.
  await page.getByRole('button', { name: 'Create export' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Ready'),
    60000,
    'export ready',
  );
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('button', { name: 'Download' }).first().click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const csv = readFileSync(downloadPath, 'utf8');
  check(
    'export download produces a private CSV with the report content',
    csv.includes('revenue_journal.REVENUE_ROOM') &&
      csv.includes('400000') &&
      download.suggestedFilename().endsWith('.csv'),
    download.suggestedFilename(),
  );
  check(
    'CSV cells never start a spreadsheet formula',
    csv
      .split('\r\n')
      .flatMap((line) => line.split(','))
      .every(
        (cell) =>
          cell.length === 0 || !['=', '+', '@', '\t', '\r'].includes(cell[0]),
      ),
  );
  await shot(page, 'reports-export-ready');
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await waitFor(
    async () => (await bodyText(page)).includes('Revoked'),
    15000,
    'revoke state',
  );
  check('revoking an export is reflected immediately', true);

  // Pickup snapshot flow.
  await page.getByLabel('Report').click();
  await page.getByRole('option', { name: 'Pickup' }).click();
  await page.getByLabel('Reference date').fill(today);
  await page.getByRole('button', { name: 'Capture pickup snapshot' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Run report' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Pickup nights net'),
    30000,
    'pickup metrics',
  );
  check(
    'pickup reports the declared snapshot delta',
    (await bodyText(page)).includes('Pickup nights added'),
  );
  await shot(page, 'reports-pickup');

  dbEvidence.exports = await dbRows(
    `select "kind", "state", "format", "expires_at" is not null as "has_expiry",
            "content" is null as "content_deleted"
       from "report_export" where "property_id" = $1 order by "created_at"`,
    [property.propertyId],
  );
  check(
    'database shows a generated then revoked export with deleted content',
    dbEvidence.exports.some(
      (row) => row.state === 'REVOKED' && row.content_deleted,
    ) &&
      dbEvidence.exports.every((row) => row.format === 'CSV' && row.has_expiry),
    JSON.stringify(dbEvidence.exports),
  );

  // Owner without MFA can read but cannot export.
  await ownerPage.goto(`${baseUrl}/properties/${property.propertyId}/reports`, {
    waitUntil: 'domcontentloaded',
  });
  await ownerPage
    .getByRole('button', { name: 'Run report' })
    .waitFor({ timeout: 20000 });
  await ownerPage.getByRole('button', { name: 'Run report' }).click();
  await ownerPage.waitForTimeout(1500);
  await ownerPage.getByRole('button', { name: 'Create export' }).click();
  await waitFor(
    async () => (await bodyText(ownerPage)).includes('second factor'),
    20000,
    'mfa required',
  );
  check(
    'owner without MFA is rejected on export while reports stay readable',
    true,
  );
  await shot(ownerPage, 'reports-mfa-required');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/properties/${property.propertyId}/reports`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: 'Run report' })
    .waitFor({ timeout: 20000 });
  const mobileOverflow = await overflow(page);
  check(
    'reports page has no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.bodyDelta <= 1,
    JSON.stringify(mobileOverflow),
  );
  await shot(page, 'reports-390');

  await setLanguage(page, /العربية/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/properties/${property.propertyId}/reports`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: 'تشغيل التقرير' })
    .waitFor({ timeout: 20000 });
  check(
    'reports screen renders in Arabic RTL',
    await page.evaluate(
      () => document.documentElement.getAttribute('dir') === 'rtl',
    ),
  );
  await shot(page, 'reports-ar-rtl');
  await setLanguage(page, /English/);
  check(
    'no page errors or console errors during the visual run',
    pageErrors.length === 0 && consoleErrors.length === 0,
    JSON.stringify({ pageErrors, consoleErrors }),
  );
} catch (error) {
  check('visual run completed without throwing', false, String(error));
  console.error(error);
} finally {
  writeFileSync(
    `${outDir}/report.json`,
    `${JSON.stringify(
      {
        scope,
        generated_at: new Date().toISOString(),
        base_url: baseUrl,
        browser: 'chromium',
        engine: 'playwright',
        exception:
          'Computer Use unavailable in this environment (same as P05..P10)',
        checks,
        failures,
        screenshots,
        page_errors: pageErrors,
        console_errors: consoleErrors,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    `${outDir}/db-evidence.json`,
    `${JSON.stringify(dbEvidence, null, 2)}\n`,
  );
  await context.close();
  await ownerContext.close();
  await browser.close();
  const passed = checks.filter((row) => row.ok).length;
  console.log(
    `${passed}/${checks.length} checks passed; ${screenshots.length} screenshots`,
  );
  if (failures.length > 0) process.exitCode = 1;
}
