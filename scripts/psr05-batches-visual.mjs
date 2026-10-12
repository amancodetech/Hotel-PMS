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

const out = '.local/verification/PSR-05-batches';
mkdirSync(out + '/zoom-extension', { recursive: true });
const extension = process.cwd() + '/' + out + '/zoom-extension';
writeFileSync(
  extension + '/manifest.json',
  JSON.stringify({
    manifest_version: 3,
    name: 'Local zoom verification',
    version: '1.0',
    permissions: ['tabs'],
    background: { service_worker: 'background.js' },
  }),
);
writeFileSync(
  extension + '/background.js',
  'chrome.runtime.onInstalled.addListener(() => {});',
);
const context = await chromium.launchPersistentContext(
  out + '/browser-profile-' + Date.now(),
  {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const checks = [],
  errors = [];
function check(name, ok) {
  assert.ok(ok, name);
  checks.push(name);
}
async function tabTo(page, locator) {
  for (let n = 0; n < 180; n++) {
    if (await locator.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw Error(
    'Cannot reach control with keyboard: ' +
      (await locator.getAttribute('aria-label')),
  );
}
async function activate(page, name) {
  const target = page.getByRole('button', { name, exact: true });
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}
async function typeField(page, label, value) {
  await tabTo(page, page.getByLabel(label, { exact: true }));
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
}
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
    const s = await (await fetch('/api/v1/auth/session')).json(),
      tenant = s.session.active_tenant_id;
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    const r = await fetch(`/api/v1/tenants/${tenant}/properties`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        code: 'BATCH-' + Date.now(),
        name: 'Batch keyboard hotel',
        timezone: 'Asia/Makassar',
      }),
    });
    if (!r.ok) throw Error('fixture ' + r.status);
    return { tenant, id: (await r.json()).property.id };
  });
  await page.goto(`${baseUrl}/properties/${fixture.id}/structure`);
  await page.getByLabel('Property name', { exact: false }).waitFor();
  await activate(page, 'Next');
  await activate(page, 'Add units');
  await typeField(page, 'Number range', '101-120');
  await typeField(page, 'Excluded numbers, separated by commas', '113');
  await typeField(page, 'Guest capacity per unit', '0');
  await activate(page, 'Save draft');
  await page.locator('.MuiAlert-standardError').waitFor();
  check(
    'invalid capacity is reported without losing room numbers',
    (await page.getByLabel('Number range', { exact: true }).inputValue()) ===
      '101-120',
  );
  await typeField(page, 'Guest capacity per unit', '2');
  await activate(page, 'Next');
  await activate(page, 'Next');
  await activate(page, 'Save draft');
  await page.getByText('Draft saved on the server.', { exact: true }).waitFor();
  await activate(page, 'Preview saved plan');
  await page
    .getByText('This setup will run in 2 batches.', { exact: true })
    .waitFor();
  check(
    'four-step setup and save/preview reached using Tab and Enter only',
    true,
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const before = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    width: window.innerWidth,
  }));
  const nativeZoom = await worker.evaluate(async (origin) => {
    const tabs = await globalThis.chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(origin));
    await globalThis.chrome.tabs.setZoom(tab.id, 2);
    return globalThis.chrome.tabs.getZoom(tab.id);
  }, baseUrl);
  await page.waitForFunction(
    (dpr) => window.devicePixelRatio > dpr * 1.9,
    before.dpr,
  );
  check('native browser zoom reports 200 percent', nativeZoom === 2);
  check(
    'native 200 percent has no horizontal page overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  const start = page.getByRole('button', {
    name: 'Start batch setup',
    exact: true,
  });
  await tabTo(page, start);
  check(
    'batch action reachable at native 200 percent',
    (await start.isVisible()) && (await start.isEnabled()),
  );
  check(
    'critical controls fit native zoom viewport',
    await page
      .locator('fieldset input,fieldset button')
      .evaluateAll((elements) =>
        elements
          .filter((el) => el.getClientRects().length)
          .every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= -1 && r.right <= window.innerWidth + 1;
          }),
      ),
  );
  await page.waitForTimeout(200);
  const zoomMetrics = await start.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      unobscured: hit === el || el.contains(hit),
    };
  });
  check(
    'keyboard-focused batch action is inside native zoom viewport and unobscured',
    zoomMetrics.rect.top >= 0 &&
      zoomMetrics.rect.bottom <= zoomMetrics.height &&
      zoomMetrics.unobscured,
  );
  writeFileSync(
    out + '/zoom-metrics.json',
    JSON.stringify(zoomMetrics, null, 2),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({
    path: out + '/native-zoom-200.png',
    fullPage: false,
  });
  await worker.evaluate(async (origin) => {
    const tab = (await globalThis.chrome.tabs.query({})).find((t) =>
      t.url?.startsWith(origin),
    );
    await globalThis.chrome.tabs.setZoom(tab.id, 1);
  }, baseUrl);
  let dropped = false;
  await page.route('**/setup-batches/*/advance', async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await activate(page, 'Start batch setup');
  await activate(page, 'Confirm action');
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  page.once('dialog', (d) => d.accept());
  await page.reload();
  await page
    .getByRole('button', { name: 'Resume batches', exact: true })
    .waitFor();
  check(
    'reload recovers server progress after lost batch response',
    (await page.getByText(/Created 10 of 19 units/).count()) > 0,
  );
  await activate(page, 'Resume batches');
  await page.getByText(/Created 19 of 19 units/).waitFor();
  const facts = await page.evaluate(async ({ tenant, id }) => {
    const root = `/api/v1/tenants/${tenant}/properties/${id}`;
    return {
      resources: await (await fetch(root + '/resources?limit=50')).json(),
      draft: await (await fetch(root + '/setup-draft')).json(),
    };
  }, fixture);
  check(
    'nineteen distinct rooms and excluded number absent',
    facts.resources.items.length === 19 &&
      new Set(facts.resources.items.map((r) => r.code)).size === 19 &&
      !facts.resources.items.some((r) => r.code === '113'),
  );
  check(
    'draft completed only after final batch',
    facts.draft.draft.completed === true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'batch result at390px no overflow',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({ path: out + '/batch-mobile.png', fullPage: true });
  check('no page exceptions', errors.length === 0);
  writeFileSync(
    out + '/browser.json',
    JSON.stringify({ checks, errors, fixture, nativeZoom, before }, null, 2),
  );
  console.log(checks.length + ' checks passed');
} finally {
  await context.close();
}
