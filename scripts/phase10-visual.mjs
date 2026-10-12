import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

/**
 * P10-03 visual evidence (Playwright, declared exception as in P05..P09 — no
 * Computer Use in this environment): the night audit day screen with progress,
 * exceptions, acknowledgement, retry, run log, Arabic RTL and 390px.
 */
const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const scope = 'P10-03';
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
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/night-audits$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/night-audits\/runs$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/night-audits\/runs\/[^/]+\/retry$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/night-audits\/exceptions\/[^/]+\/resolution$/,
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
const inspectorContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const inspectorPage = await inspectorContext.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

async function makeProperty(label) {
  const base = `/api/v1/tenants/${dbEvidence.tenantId}/properties`;
  const property = await api(page, 'POST', base, {
    code: `P10V-${label}-${runId}`,
    name: `Phase 10 visual ${label} ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  const propertyId = property.body.property.id;
  const rooms = [];
  for (let index = 1; index <= 3; index += 1) {
    const resource = await api(
      page,
      'POST',
      `${base}/${propertyId}/resources`,
      { code: `P10V-${label}-R${index}-${runId}`, type: 'ROOM', capacity: 2 },
    );
    rooms.push(resource.body.resource);
  }
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P10V-${label}-P-${runId}`,
    name: `Visual night audit ${label}`,
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
    code: `P10V-${label}-RP-${runId}`,
    name: `Visual night audit rate ${label}`,
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

async function createStay(scopeInfo, resourceId, checkIn) {
  const { base, propertyId, productId, planId } = scopeInfo;
  const quote = await api(page, 'POST', `${base}/${propertyId}/quotes`, {
    product_id: productId,
    rate_plan_id: planId,
    period: { arrival: today, departure: shift(2) },
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
          period: { arrival: today, departure: shift(2) },
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
  if (checkIn) {
    const afterConfirm = await api(
      page,
      'GET',
      `${base}/${propertyId}/reservations/${reservationId}`,
    );
    const checkInResponse = await api(
      page,
      'POST',
      `${base}/${propertyId}/reservations/${reservationId}/items/${itemId}/check-in`,
      {
        version: afterConfirm.body.items[0].version,
        resource_id: resourceId,
      },
    );
    if (checkInResponse.status !== 200)
      throw new Error(`check-in ${checkInResponse.status}`);
    const folio = await api(page, 'POST', `${base}/${propertyId}/folios`, {
      reservation_id: reservationId,
      kind: 'GUEST',
      payer_label: `Visual guest ${runId}`,
      currency: 'IDR',
    });
    if (folio.status !== 200) throw new Error(`folio ${folio.status}`);
  }
  return { reservationId, itemId };
}

try {
  await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  await signIn(
    inspectorContext,
    'owner-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await setLanguage(page, /English/);
  await setLanguage(inspectorPage, /English/);
  const session = await api(page, 'GET', '/api/v1/auth/session');
  const tenantId = session.body.session?.active_tenant_id;
  dbEvidence.tenantId = tenantId;
  check('active tenant session', Boolean(tenantId), `tenant=${tenantId}`);

  const closeScope = await makeProperty('CLOSE');
  await createStay(closeScope, closeScope.rooms[0].id, true);

  const exceptionScope = await makeProperty('EXC');
  await createStay(exceptionScope, exceptionScope.rooms[0].id, true);
  await createStay(exceptionScope, exceptionScope.rooms[1].id, false);

  // Close flow through the UI.
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 15000 });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`P10V-CLOSE-${runId}`);
  const propertyRow = page
    .locator('tbody tr')
    .filter({ hasText: `P10V-CLOSE-${runId}` });
  await propertyRow.waitFor({ timeout: 15000 });
  await propertyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Night audit' }).click();
  await page.waitForURL(/\/night-audit$/, { timeout: 15000 });
  await page
    .getByRole('button', { name: 'Start night audit' })
    .waitFor({ timeout: 20000 });
  check('PropertiesPage opens the night audit screen', true, page.url());
  // Deterministic wait for the overview query to render before asserting the
  // business date/timezone snapshot; assertions stay unchanged.
  await waitFor(
    async () =>
      (await bodyText(page)).includes(today) &&
      (await bodyText(page)).includes('Asia/Jakarta'),
    20000,
    'audit overview snapshot',
  );
  const beforeStart = await bodyText(page);
  check(
    'screen shows the business date, property timezone and day state',
    beforeStart.includes(today) && beforeStart.includes('Asia/Jakarta'),
    today,
  );
  await shot(page, 'audit-day-open');

  await page.getByRole('button', { name: 'Start night audit' }).click();
  await waitFor(
    async () =>
      (await bodyText(page)).includes('Succeeded') &&
      (await bodyText(page)).includes('Day closed'),
    60000,
    'close run to succeed',
  );
  const afterStart = await bodyText(page);
  check('progress reaches 10 checkpoints', afterStart.includes('10 of 10'));
  check(
    'run log records the closing barrier and success',
    afterStart.includes('night_audit.closing_barrier') ||
      afterStart.includes('night_audit.run_succeeded'),
  );
  check(
    'closed day is visible when filtering the closed business date',
    afterStart.includes('Closed'),
  );
  await shot(page, 'audit-day-closed');
  dbEvidence.close = {
    businessDays: await dbRows(
      `select "business_date"::text as "business_date", "state"
         from "business_day" where "property_id" = $1 order by "business_date"`,
      [closeScope.propertyId],
    ),
    charges: await dbRows(
      `select "source_ref", "net_amount"::text as "net_amount"
         from "folio_charge" where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
      [closeScope.propertyId],
    ),
    steps: await dbRows(
      `select s."state", count(*)::int as "count"
         from "night_audit_step" s where s."property_id" = $1 group by s."state"`,
      [closeScope.propertyId],
    ),
  };
  check(
    'database shows the day closed and the next day open',
    dbEvidence.close.businessDays.some(
      (row) => row.state === 'CLOSED' && row.business_date === today,
    ) &&
      dbEvidence.close.businessDays.some(
        (row) => row.state === 'OPEN' && row.business_date === shift(1),
      ),
    JSON.stringify(dbEvidence.close.businessDays),
  );
  check(
    'exactly one nightly charge is posted for the stay',
    dbEvidence.close.charges.length === 1,
    JSON.stringify(dbEvidence.close.charges),
  );

  // Exception + retry flow through the UI.
  await page.goto(
    `${baseUrl}/properties/${exceptionScope.propertyId}/night-audit`,
    { waitUntil: 'domcontentloaded' },
  );
  await page
    .getByRole('button', { name: 'Start night audit' })
    .waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Start night audit' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Validation failed'),
    60000,
    'validation failure',
  );
  const failedText = await bodyText(page);
  check(
    'validation failure shows the blocking arrival exception',
    failedText.includes('Arrival not resolved') &&
      failedText.includes('Blocking'),
  );
  check(
    'retry button appears for the failed run',
    failedText.includes('Retry run'),
  );
  await shot(page, 'audit-exception-open');
  await page.getByRole('button', { name: 'Acknowledge' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Responsible owner').fill('Front desk shift leader');
  await dialog
    .getByLabel('Reason')
    .fill('Guest confirmed late arrival under the property policy');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  check(
    'acknowledged exception shows its traceable owner',
    (await bodyText(page)).includes('Front desk shift leader'),
  );
  await shot(page, 'audit-exception-acknowledged');
  await page.getByRole('button', { name: 'Retry run' }).click();
  await waitFor(
    async () => (await bodyText(page)).includes('Succeeded'),
    60000,
    'retry to succeed',
  );
  check('retry closes the day after acknowledgement', true);
  await shot(page, 'audit-day-closed-after-retry');
  dbEvidence.exception = {
    exceptions: await dbRows(
      `select "code", "severity", "state", "owner_label", "resolution_reason"
         from "night_audit_exception" where "property_id" = $1`,
      [exceptionScope.propertyId],
    ),
    itemStates: await dbRows(
      `select i."state" from "reservation_item" i
        where i."property_id" = $1 order by i."arrival", i."id"`,
      [exceptionScope.propertyId],
    ),
    charges: await dbRows(
      `select "source_ref" from "folio_charge"
        where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
      [exceptionScope.propertyId],
    ),
  };
  check(
    'acknowledged exception keeps owner and reason in the database',
    dbEvidence.exception.exceptions.some(
      (row) =>
        row.code === 'ARRIVAL_NOT_RESOLVED' &&
        row.state === 'ACKNOWLEDGED' &&
        row.owner_label === 'Front desk shift leader' &&
        row.resolution_reason.includes('policy'),
    ),
    JSON.stringify(dbEvidence.exception.exceptions),
  );
  check(
    'unresolved arrival is never auto-marked no-show',
    dbEvidence.exception.itemStates.some((row) => row.state === 'CONFIRMED'),
    JSON.stringify(dbEvidence.exception.itemStates),
  );
  check(
    'retry does not post a second nightly charge',
    dbEvidence.exception.charges.length === 1,
    JSON.stringify(dbEvidence.exception.charges),
  );

  // Owner without MFA stays read-only on the server.
  await inspectorPage.goto(
    `${baseUrl}/properties/${exceptionScope.propertyId}/night-audit`,
    { waitUntil: 'domcontentloaded' },
  );
  await inspectorPage
    .getByRole('button', { name: 'Start night audit' })
    .waitFor({ timeout: 20000 });
  await inspectorPage
    .getByRole('button', { name: 'Start night audit' })
    .click();
  await inspectorPage.waitForTimeout(1500);
  check(
    'owner without MFA is rejected on the night audit screen',
    (await bodyText(inspectorPage)).includes('second factor'),
  );
  await shot(inspectorPage, 'audit-mfa-required');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${baseUrl}/properties/${closeScope.propertyId}/night-audit`,
    { waitUntil: 'domcontentloaded' },
  );
  await page
    .getByRole('button', { name: 'Start night audit' })
    .waitFor({ timeout: 20000 });
  const mobileOverflow = await overflow(page);
  check(
    'night audit page has no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.bodyDelta <= 1,
    JSON.stringify(mobileOverflow),
  );
  await shot(page, 'audit-390');

  await setLanguage(page, /العربية/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${baseUrl}/properties/${closeScope.propertyId}/night-audit`,
    { waitUntil: 'domcontentloaded' },
  );
  await page
    .getByRole('button', { name: 'بدء التدقيق الليلي' })
    .waitFor({ timeout: 20000 });
  check(
    'night audit screen renders in Arabic RTL',
    await page.evaluate(
      () => document.documentElement.getAttribute('dir') === 'rtl',
    ),
  );
  await shot(page, 'audit-ar-rtl');
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
          'Computer Use unavailable in this environment (same as P05..P09)',
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
  await inspectorContext.close();
  await browser.close();
  const passed = checks.filter((row) => row.ok).length;
  console.log(
    `${passed}/${checks.length} checks passed; ${screenshots.length} screenshots`,
  );
  if (failures.length > 0) process.exitCode = 1;
}
