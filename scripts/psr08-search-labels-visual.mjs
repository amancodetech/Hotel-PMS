import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
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

const out = '.local/verification/PSR-08/search-labels-' + Date.now();
mkdirSync(out, { recursive: true });
copyFileSync('scripts/psr08-search-labels-visual.mjs', out + '/source.mjs');
const fixture = JSON.parse(
  readFileSync(
    process.env.PSR08_LABEL_FIXTURE ??
      '.local/verification/PSR-08/search-browser-1791091615800/fixture.json',
    'utf8',
  ),
);
const checks = [],
  errors = [];
const extension = process.cwd() + '/' + out + '/zoom-extension';
mkdirSync(extension, { recursive: true });
writeFileSync(
  extension + '/manifest.json',
  JSON.stringify({
    manifest_version: 3,
    name: 'Local label zoom verification',
    version: '1.0',
    permissions: ['tabs'],
    background: { service_worker: 'background.js' },
  }),
);
writeFileSync(
  extension + '/background.js',
  'chrome.runtime.onInstalled.addListener(()=>{});',
);
const context = await chromium.launchPersistentContext(out + '/profile', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
async function tabTo(page, locator) {
  for (let n = 0; n < 180; n++) {
    if (await locator.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw Error('Cannot focus search field with keyboard');
}
function check(name, value) {
  checks.push({ name, status: value ? 'PASS' : 'FAIL' });
  assert.ok(value, name);
}
async function labels(page, queryLabel, expected, name) {
  const input = page.getByLabel(queryLabel, { exact: true });
  await input.waitFor();
  await input.scrollIntoViewIfNeeded();
  const form = input.locator('xpath=ancestor::form');
  await page.evaluate(() => document.fonts.ready);
  const metrics = await form.evaluate((el) => ({
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
    },
    labels: Array.from(el.querySelectorAll('label')).map((label) => {
      const rect = label.getBoundingClientRect(),
        range = document.createRange();
      range.selectNodeContents(label);
      const textRect = range.getBoundingClientRect();
      return {
        text: label.textContent,
        clientWidth: label.clientWidth,
        scrollWidth: label.scrollWidth,
        labelRect: {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          top: rect.top,
          bottom: rect.bottom,
        },
        textRect: {
          left: textRect.left,
          right: textRect.right,
          width: textRect.width,
        },
        overflow: getComputedStyle(label).overflow,
        textOverflow: getComputedStyle(label).textOverflow,
        fullyVisible:
          label.scrollWidth <= label.clientWidth + 1 &&
          textRect.width <= rect.width + 2,
      };
    }),
  }));
  writeFileSync(
    out + '/' + name + '-metrics.json',
    JSON.stringify(metrics, null, 2),
  );
  await form.screenshot({ path: out + '/' + name + '-form.png' });
  for (const text of expected) {
    const metric = metrics.labels.find((label) => label.text === text);
    check(
      name + ' label fully visible: ' + text,
      Boolean(metric?.fullyVisible),
    );
  }
  check(
    name + ' labels stay within viewport',
    metrics.labels.every(
      (label) =>
        label.labelRect.left >= -1 &&
        label.labelRect.right <= metrics.viewport.width + 1,
    ),
  );
  return metrics;
}
try {
  const page = await signIn(
    context,
    'admin-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
    process.env.KEYCLOAK_ADMIN_TOTP_KEY,
  );
  page.on('pageerror', (e) => errors.push(e.message));
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  async function zoom(value) {
    return worker.evaluate(
      async ({ origin, value }) => {
        const tab = (await globalThis.chrome.tabs.query({})).find((t) =>
          t.url?.startsWith(origin),
        );
        await globalThis.chrome.tabs.setZoom(tab.id, value);
        return globalThis.chrome.tabs.getZoom(tab.id);
      },
      { origin: baseUrl, value },
    );
  }
  for (const [option, lang, rtl] of [
    ['English', 'en-US', false],
    ['Bahasa Indonesia', 'id-ID', false],
    ['العربية', 'ar', true],
  ]) {
    await zoom(1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(baseUrl + '/preferences');
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await page.waitForFunction(
      (lang) => document.documentElement.lang === lang,
      lang,
    );
    const l = JSON.parse(
      readFileSync(`packages/i18n/src/locales/${lang}.json`, 'utf8'),
    );
    for (const mode of ['mobile390', 'desktop1440', 'native200']) {
      await zoom(1);
      await page.setViewportSize(
        mode === 'mobile390'
          ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 },
      );
      await page.goto(`${baseUrl}/properties/${fixture.id}`);
      await page
        .getByRole('tab', { name: l.resourcesTab, exact: true })
        .click();
      if (mode === 'native200') {
        const before = await page.evaluate(() => window.devicePixelRatio);
        check(lang + ' actual native zoom200', (await zoom(2)) === 2);
        await page.waitForFunction(
          (dpr) => window.devicePixelRatio > dpr * 1.9,
          before,
        );
      }
      const resources = await labels(
        page,
        l.psrSearch.query,
        [
          l.psrSearch.query,
          l.psrSearch.sort,
          l.resourceType,
          l.psrSearch.minCapacity,
          l.psrSearch.bedrooms,
          l.psrSearch.bathrooms,
        ],
        lang + '-' + mode + '-resources',
      );
      if (mode === 'mobile390')
        check(
          lang + ' actual390 RTL state',
          resources.viewport.width === 390 &&
            (resources.viewport.dir === 'rtl') === rtl,
        );
      if (mode === 'native200') {
        const field = page.getByLabel(l.psrSearch.query, { exact: true });
        await tabTo(page, field);
        await page.keyboard.type('Ocean');
        const response = page.waitForResponse(
          (r) =>
            r.url().includes('/resources?') &&
            new URL(r.url()).searchParams.get('q') === 'Ocean',
        );
        await page.keyboard.press('Enter');
        check(
          lang + ' keyboard search after label layout fix',
          (await (await response).json()).items.length === 2,
        );
      }
      await page.goto(`${baseUrl}/properties/${fixture.id}/structure`);
      await labels(
        page,
        l.psrSearch.placeQuery,
        [l.psrSearch.placeQuery, l.psrSearch.sort, l.psrSearch.placeKind],
        lang + '-' + mode + '-places',
      );
    }
  }
  check('No page exceptions', errors.length === 0);
} catch (error) {
  errors.push({ message: error.message, stack: error.stack });
  throw error;
} finally {
  writeFileSync(
    out + '/result.json',
    JSON.stringify({ checks, errors, fixture }, null, 2),
  );
  await context.close();
}
