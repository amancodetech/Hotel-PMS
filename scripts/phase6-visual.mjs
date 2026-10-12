import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const outDir = '.local/verification/P06-01';
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
const idempotentPaths = [
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/drafts$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservation-items\/[^/]+\/cancel$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/imports$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/guests$/,
  /^\/api\/v1\/tenants\/[^/]+\/guests$/,
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
    ['POST', 'PATCH'].includes(method) &&
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
function shift(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const runId = String(Date.now()).slice(-6);
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

try {
  await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /English/ }).click();
  await page.waitForTimeout(800);
  const session = await api(page, 'GET', '/api/v1/auth/session');
  const tenantId = session.body.session?.active_tenant_id;
  check('active tenant session', Boolean(tenantId));

  const property = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties`,
    {
      code: `P6V-${runId}`,
      name: `Phase 6 visual ${runId}`,
      timezone: 'Asia/Jakarta',
    },
  );
  check(
    'visual property created',
    property.status === 201,
    `status=${property.status}`,
  );
  const propertyId = property.body.property.id;

  const guest = await api(page, 'POST', `/api/v1/tenants/${tenantId}/guests`, {
    full_name: `Visual Guest ${runId}`,
    email: `p6v-${runId}@example.com`,
  });
  check('visual guest created', guest.status === 201, `status=${guest.status}`);
  const guestId = guest.body.guest.id;

  const draft = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/drafts`,
    {
      source: 'DIRECT',
      items: [
        {
          period: { arrival: shift(1), departure: shift(3) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
      guests: [{ guest_id: guestId, role: 'LEAD' }],
    },
  );
  check(
    'visual draft created without inventory',
    draft.status === 201 && draft.body.reservation.state === 'INQUIRY',
    `status=${draft.status} state=${draft.body.reservation?.state}`,
  );

  await page.goto(`${baseUrl}/properties/${propertyId}`, {
    waitUntil: 'domcontentloaded',
  });
  const navLink = page.locator('nav a[href$="/reservations"]');
  await navLink.waitFor({ timeout: 15000 });
  await navLink.click();
  await page.waitForURL(/\/reservations$/, { timeout: 15000 });
  await page.waitForSelector('table', { timeout: 15000 });
  check('sidebar link opens the reservations page', true);
  const tabs = await page.getByRole('tab').count();
  check('reservations page exposes tabs', tabs >= 2, `tabs=${tabs}`);
  const listText = await page.textContent('body');
  check('draft visible with derived inquiry state', /Inquiry/.test(listText));
  check('draft row count reaches guests', /1 · INQUIRY/.test(listText));
  await shot(page, 'reservations-list');

  await page.getByRole('button', { name: 'Details' }).last().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
  const detailText = await page.textContent('[role="dialog"]');
  check(
    'detail shows lead guest and period',
    detailText.includes(`Visual Guest ${runId}`) &&
      detailText.includes(shift(1)) &&
      detailText.includes(shift(3)),
  );
  await shot(page, 'reservation-detail');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'New draft' }).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1200);
  const createdText = await page.textContent('[role="dialog"]');
  check('draft can be created from the UI', /Inquiry/.test(createdText));
  await shot(page, 'draft-created');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(400);

  await page.getByRole('tab', { name: 'Guests' }).click();
  await page.waitForTimeout(800);
  await page.getByLabel('Search guests').fill(`Visual Guest ${runId}`);
  await page.waitForTimeout(800);
  const guestsText = await page.textContent('body');
  check(
    'guest registry lists the guest',
    guestsText.includes(`Visual Guest ${runId}`) &&
      guestsText.includes(`p6v-${runId}@example.com`),
  );
  await shot(page, 'guests-list');

  const resource = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/resources`,
    { code: `P6V-R-${runId}`, type: 'ROOM', capacity: 2 },
  );
  const product = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/products`,
    {
      code: `P6V-P-${runId}`,
      name: 'Visual full path room',
      kind: 'ROOM',
      occupancy_adults_max: 2,
    },
  );
  const productId = product.body.product.id;
  await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}/candidates`,
    { resource_id: resource.body.resource.id },
  );
  await api(
    page,
    'PATCH',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/products/${productId}`,
    { version: product.body.product.version, status: 'ACTIVE' },
  );
  const plan = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/rate-plans`,
    {
      code: `P6V-RATE-${runId}`,
      name: 'Visual full path rate',
      product_id: productId,
      currency: 'IDR',
    },
  );
  const planId = plan.body.rate_plan.id;
  await api(
    page,
    'PATCH',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/rate-plans/${planId}`,
    { version: plan.body.rate_plan.version, status: 'ACTIVE' },
  );
  const cells = [];
  for (let offset = 1; offset <= 10; offset += 1)
    cells.push({
      rate_plan_id: planId,
      date: shift(offset),
      occupancy: 2,
      money: { amount: '285000', currency: 'IDR' },
    });
  await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/rates/batch`,
    { cells },
  );
  const inventoryVersion = async () =>
    (
      await api(
        page,
        'GET',
        `/api/v1/tenants/${tenantId}/properties/${propertyId}/rates?from=${shift(1)}&to=${shift(10)}`,
      )
    ).body.inventory_version;
  const fullPath = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/drafts`,
    {
      source: 'DIRECT',
      items: [
        {
          product_id: productId,
          period: { arrival: shift(3), departure: shift(5) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
    },
  );
  const fullPathId = fullPath.body.reservation.id;
  const fullPathItem = (
    await api(
      page,
      'GET',
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/${fullPathId}`,
    )
  ).body.items[0].id;
  const quote = async (arrival, departure) =>
    (
      await api(
        page,
        'POST',
        `/api/v1/tenants/${tenantId}/properties/${propertyId}/quotes`,
        {
          product_id: productId,
          rate_plan_id: planId,
          period: { arrival, departure },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      )
    ).body.quote.id;
  const modifyQuote = await quote(shift(3), shift(6));
  const confirmed = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations`,
    {
      reservation_id: fullPathId,
      inventory_version: await inventoryVersion(),
      items: [
        {
          item_id: fullPathItem,
          price_snapshot_id: await quote(shift(3), shift(5)),
        },
      ],
    },
  );
  check(
    'simulator confirms a booking',
    confirmed.status === 200 && confirmed.body.state === 'CONFIRMED',
    `status=${confirmed.status}`,
  );
  const modified = await api(
    page,
    'PATCH',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/${fullPathId}`,
    {
      version: confirmed.body.version,
      items: [
        {
          item_id: fullPathItem,
          period: { arrival: shift(3), departure: shift(6) },
          price_snapshot_id: modifyQuote,
        },
      ],
    },
  );
  check(
    'simulator modifies the booking atomically',
    modified.status === 200 &&
      modified.body.inventory_version > confirmed.body.inventory_version,
    `status=${modified.status}`,
  );
  const itemVersion = (
    await api(
      page,
      'GET',
      `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/${fullPathId}`,
    )
  ).body.items[0].version;
  const cancelled = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservation-items/${fullPathItem}/cancel`,
    { version: itemVersion, reason: 'phase6 simulator cancellation' },
  );
  check(
    'simulator cancels the booking item',
    cancelled.status === 200 && cancelled.body.state === 'CANCELLED',
    `status=${cancelled.status}`,
  );
  const restored = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/drafts`,
    {
      source: 'DIRECT',
      items: [
        {
          product_id: productId,
          period: { arrival: shift(7), departure: shift(9) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
    },
  );
  check(
    'simulator restores by a fresh draft',
    restored.status === 201 && restored.body.reservation.state === 'INQUIRY',
    `status=${restored.status}`,
  );
  await page.goto(`${baseUrl}/properties/${propertyId}/reservations`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('table', { timeout: 15000 });
  const pathText = await page.textContent('body');
  check(
    'UI reflects the full path states',
    /Cancelled/.test(pathText) && /Inquiry/.test(pathText),
  );
  await page.getByRole('tab', { name: 'Calendar' }).click();
  await page.waitForTimeout(1200);
  const calendarText = await page.textContent('body');
  check(
    'calendar tab renders the planning window',
    calendarText.includes('Calendar'),
  );
  await shot(page, 'reservation-calendar');

  const connection = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/connections`,
    {
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      channel_key: 'BOOKING_COM',
      external_property_id: `p6v-${runId}`,
      secret_ref: 'local:hotel/p6-visual',
    },
  );
  const ota = await api(
    page,
    'POST',
    `/api/v1/tenants/${tenantId}/properties/${propertyId}/reservations/drafts`,
    {
      source: 'OTA',
      channel_connection_id: connection.body.connection.id,
      external_booking_key: `P6V-OTA-${runId}`,
      items: [
        {
          product_id: productId,
          period: { arrival: shift(8), departure: shift(10) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
    },
  );
  check(
    'external OTA request is stored as a pending external draft',
    ota.status === 201 && ota.body.reservation.state === 'INQUIRY',
    `status=${ota.status}`,
  );
  const pageText = await page.textContent('body');
  check(
    'no payment button is exposed over the stub',
    !/Pay now|RecordPayment/i.test(pageText),
  );
  await page.goto(`${baseUrl}/properties/${propertyId}/reservations`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('table', { timeout: 15000 });
  const otaText = await page.textContent('body');
  check('OTA draft is visible in the booking list', /OTA/.test(otaText));
  await shot(page, 'reservations-ota');

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /العربية/ }).click();
  await page.waitForTimeout(800);
  await page.goto(`${baseUrl}/properties/${propertyId}/reservations`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('table', { timeout: 15000 });
  const dir = await page.evaluate(() => document.documentElement.dir);
  check('reservations page is RTL in Arabic', dir === 'rtl', `dir=${dir}`);
  await shot(page, 'reservations-rtl');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const documentElement = document.documentElement;
    const inScrollContainer = (element) => {
      let node = element.parentElement;
      while (node && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (inScrollContainer(element)) continue;
      if (box.right > viewport + 1 || box.left < -1) {
        offenders.push(element.tagName.toLowerCase());
      }
    }
    return {
      delta: documentElement.scrollWidth - documentElement.clientWidth,
      offenders: offenders.slice(0, 5),
    };
  });
  check(
    'no horizontal overflow at 390px',
    overflow.delta <= 1 && overflow.offenders.length === 0,
    JSON.stringify(overflow),
  );
  await shot(page, 'reservations-mobile');

  await page.getByRole('button', { name: 'فتح قائمة التنقل' }).click();
  const mobileNavigation = page.locator('.mobile-nav-paper');
  await mobileNavigation.waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  check(
    'mobile navigation opens as a drawer in RTL',
    (await mobileNavigation.textContent())?.includes('العمل اليومي') === true,
  );
  const mobileNavigationBox = await mobileNavigation.boundingBox();
  check(
    'mobile navigation follows the RTL inline edge',
    Boolean(
      mobileNavigationBox &&
      Math.abs(mobileNavigationBox.x + mobileNavigationBox.width - 390) <= 1 &&
      mobileNavigationBox.width >= 300,
    ),
    JSON.stringify(mobileNavigationBox),
  );
  await shot(page, 'reservations-mobile-navigation');
  await page.getByRole('button', { name: 'إغلاق قائمة التنقل' }).click();
  await mobileNavigation.waitFor({ state: 'hidden' });
  check(
    'mobile navigation closes and restores focus to its trigger',
    await page
      .getByRole('button', { name: 'فتح قائمة التنقل' })
      .evaluate((element) => element === document.activeElement),
  );

  check(
    'no page errors',
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '),
  );
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );
} finally {
  const report = {
    generated_at: new Date().toISOString(),
    checks,
    failures,
    screenshots,
  };
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed`,
  );
  await context.close();
  await browser.close();
  if (failures.length > 0) process.exitCode = 1;
}
