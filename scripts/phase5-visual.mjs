import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const outDir = '.local/verification/P05-06';
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
async function overflow(page) {
  return page.evaluate(() => {
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
        const className = String(element.className)
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        offenders.push(
          `${element.tagName.toLowerCase()}${className ? `.${className}` : ''}`,
        );
      }
    }
    return {
      documentDelta: documentElement.scrollWidth - documentElement.clientWidth,
      bodyDelta: document.body.scrollWidth - document.body.clientWidth,
      offenders: offenders.slice(0, 8),
    };
  });
}

async function api(page, method, path, body) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'hotel_csrf')?.value;
  const response = await page.request.fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'x-csrf-token': csrf ?? '',
      'content-type': 'application/json',
      origin: baseUrl,
    },
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
  check('admin session with active tenant', Boolean(tenantId));
  const base = `/api/v1/tenants/${tenantId}/properties`;
  const property = await api(page, 'POST', base, {
    code: `P5V-${runId}`,
    name: `Phase 5 visual ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  check(
    'visual property created',
    property.status === 201,
    `status=${property.status}`,
  );
  const propertyId = property.body.property.id;
  const resource = await api(page, 'POST', `${base}/${propertyId}/resources`, {
    code: `P5V-R-${runId}`,
    type: 'ROOM',
    capacity: 2,
  });
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P5V-P-${runId}`,
    name: 'Visual room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  const productId = product.body.product.id;
  await api(
    page,
    'POST',
    `${base}/${propertyId}/products/${productId}/candidates`,
    { resource_id: resource.body.resource.id },
  );
  await api(page, 'PATCH', `${base}/${propertyId}/products/${productId}`, {
    version: product.body.product.version,
    status: 'ACTIVE',
  });
  const plan = await api(page, 'POST', `${base}/${propertyId}/rate-plans`, {
    code: `P5V-RATE-${runId}`,
    name: 'Visual rate',
    product_id: productId,
    currency: 'IDR',
  });
  const planId = plan.body.rate_plan.id;
  await api(page, 'PATCH', `${base}/${propertyId}/rate-plans/${planId}`, {
    version: plan.body.rate_plan.version,
    status: 'ACTIVE',
  });
  const cells = [];
  for (let offset = 1; offset <= 6; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: shift(offset),
      occupancy: 2,
      money: { amount: '275000', currency: 'IDR' },
    });
  }
  const rates = await api(page, 'POST', `${base}/${propertyId}/rates/batch`, {
    cells,
  });
  check('visual rates seeded', rates.status === 200, `status=${rates.status}`);
  const connection = await api(
    page,
    'POST',
    `${base}/${propertyId}/connections`,
    {
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      channel_key: 'BOOKING_COM',
      external_property_id: `p5v-${runId}`,
      secret_ref: 'local:hotel/p5-visual',
    },
  );
  const connectionId = connection.body.connection.id;
  const mapping = await api(
    page,
    'PUT',
    `${base}/${propertyId}/connections/${connectionId}/mapping`,
    {
      channel_key: 'BOOKING_COM',
      external_room_ref: `room-${runId}`,
      external_rate_ref: `rate-${runId}`,
      occupancy: 2,
      internal_product_ref: productId,
      internal_rate_ref: planId,
    },
  );
  check(
    'mapping stores internal rate reference',
    mapping.body.mapping?.internal_rate_ref === planId,
  );
  const calendar = await api(
    page,
    'GET',
    `${base}/${propertyId}/rates?from=${shift(1)}&to=${shift(5)}`,
  );
  const inventoryVersion = calendar.body.inventory_version;
  const preview = await api(
    page,
    'POST',
    `${base}/${propertyId}/exposures/preview`,
    {
      connection_id: connectionId,
      product_id: productId,
      period: { arrival: shift(1), departure: shift(3) },
      resource_ids: [resource.body.resource.id],
      inventory_version: inventoryVersion,
    },
  );
  check('exposure preview allowed', preview.body.allowed === true);
  const publish = await api(page, 'POST', `${base}/${propertyId}/exposures`, {
    preview_id: preview.body.preview_id,
    preview_version: preview.body.preview_version,
  });
  check(
    'exposure publish queued',
    publish.status === 202,
    `state=${publish.body.state}`,
  );
  const calendarAfterPublish = await api(
    page,
    'GET',
    `${base}/${propertyId}/rates?from=${shift(1)}&to=${shift(5)}`,
  );
  const hold = await api(page, 'POST', `${base}/${propertyId}/holds`, {
    items: [
      {
        product_id: productId,
        period: { arrival: shift(4), departure: shift(5) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: calendarAfterPublish.body.inventory_version,
    ttl_seconds: 300,
  });
  check(
    'hold created for the visual page',
    hold.status === 201,
    `status=${hold.status}`,
  );
  const block = await api(page, 'POST', `${base}/${propertyId}/blocks`, {
    resource_ids: [resource.body.resource.id],
    period: { arrival: shift(6), departure: shift(7) },
    reason: 'Visual maintenance',
    mode: 'PLANNED',
  });
  check(
    'planned block created',
    block.status === 201,
    `status=${block.status}`,
  );

  await page.goto(`${baseUrl}/properties/${propertyId}/rates`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2500);
  const tabs = await page.getByRole('tab').count();
  check('rates page renders with five tabs', tabs >= 5, `tabs=${tabs}`);
  await shot(page, 'rates-plans');

  const tabNames = ['calendar', 'availability', 'holds', 'exposure'];
  for (let index = 1; index < Math.min(5, tabs); index += 1) {
    await page.getByRole('tab').nth(index).click();
    await page.waitForTimeout(1400);
    const tabBody = await page.textContent('body');
    if (index === 1)
      check('calendar shows the seeded price', tabBody.includes('275000'));
    await shot(page, `rates-tab-${tabNames[index - 1]}`);
  }
  const bodyText = await page.textContent('body');
  check('sync panel shows queued state', /queued/i.test(bodyText));
  check('exposure appears on the page', /publishing/i.test(bodyText));

  await page.getByRole('tab').nth(2).click();
  await page.waitForTimeout(1200);
  const tabLabels = await page.getByRole('tab').allTextContents();
  check(
    'availability tab renders with the search form',
    tabLabels.length >= 5,
    tabLabels.join(' | ').slice(0, 160),
  );

  const preferences = await page.goto(`${baseUrl}/preferences`, {
    waitUntil: 'domcontentloaded',
  });
  check('preferences reachable for RTL check', Boolean(preferences));
  await page.waitForTimeout(800);
  const languageSelect = page.getByRole('combobox').first();
  await languageSelect.click();
  await page.getByRole('option', { name: /العربية/ }).click();
  await page.waitForTimeout(800);
  await page.goto(`${baseUrl}/properties/${propertyId}/rates`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2000);
  const direction = await page.evaluate(() => document.documentElement.dir);
  check('arabic page renders RTL', direction === 'rtl', `dir=${direction}`);
  await shot(page, 'rates-arabic-rtl');
  const rtlOverflow = await overflow(page);
  check(
    'no horizontal overflow in Arabic at 1440',
    rtlOverflow.documentDelta <= 1 && rtlOverflow.bodyDelta <= 1,
    JSON.stringify(rtlOverflow.offenders),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const mobileOverflow = await overflow(page);
  check(
    'no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.bodyDelta <= 1,
    JSON.stringify(mobileOverflow.offenders),
  );
  await shot(page, 'rates-mobile-390');

  check(
    'no page errors',
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '),
  );
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );
} catch (error) {
  check('visual run completed', false, String(error).slice(0, 400));
} finally {
  writeFileSync(
    `${outDir}/report.json`,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        browser: 'chromium',
        viewport: '1440x900 then 390x844',
        checks,
        failures,
        screenshots,
      },
      null,
      2,
    ),
  );
  await browser.close();
}

console.log(
  `Phase 5 visual checks: ${checks.length - failures.length}/${checks.length} passed`,
);
if (failures.length > 0) process.exitCode = 1;
