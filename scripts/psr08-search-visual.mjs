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

const out = '.local/verification/PSR-08/search-browser-' + Date.now();
mkdirSync(out, { recursive: true });
copyFileSync('scripts/psr08-search-visual.mjs', out + '/source.mjs');
const checks = [],
  errors = [];
mkdirSync(out + '/zoom-extension', { recursive: true });
const extension = process.cwd() + '/' + out + '/zoom-extension';
writeFileSync(
  extension + '/manifest.json',
  JSON.stringify({
    manifest_version: 3,
    name: 'Local search zoom verification',
    version: '1.0',
    permissions: ['tabs'],
    background: { service_worker: 'background.js' },
  }),
);
writeFileSync(
  extension + '/background.js',
  'chrome.runtime.onInstalled.addListener(()=>{});',
);
const context = await chromium.launchPersistentContext(
  out + '/browser-profile',
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
  const locale = JSON.parse(
    readFileSync('packages/i18n/src/locales/en-US.json', 'utf8'),
  );
  const fixture = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/session')).json(),
      tenant = session.session.active_tenant_id,
      csrf = decodeURIComponent(
        document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
      );
    async function write(path, body) {
      const r = await fetch('/api/v1/tenants/' + tenant + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': window.crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error('fixture ' + r.status);
      return r.json();
    }
    const property = (
        await write('/properties', {
          code: 'PSR08-SEARCH-' + Date.now(),
          name: 'Synthetic search browser',
          timezone: 'Asia/Makassar',
        })
      ).property,
      root = '/properties/' + property.id;
    const parent = (
      await write(root + '/locations', {
        code: 'ROOT',
        name: 'Root',
        kind: 'BUILDING',
      })
    ).location;
    for (const [code, name] of [
      ['FL-1', 'Needle floor'],
      ['FL-2', 'Other floor'],
    ])
      await write(root + '/locations', {
        code,
        name,
        kind: 'FLOOR',
        parent_id: parent.id,
      });
    for (const [code, label, capacity] of [
      ['SEA-02', 'Ocean', 4],
      ['SEA-01', 'Ocean', 2],
      ['GARDEN', 'Garden', 2],
    ])
      await write(root + '/resources', {
        code,
        type: 'ROOM',
        capacity,
        display_label: label,
        location_id: parent.id,
      });
    return { tenant, id: property.id, parent: parent.id };
  });
  writeFileSync(out + '/fixture.json', JSON.stringify(fixture, null, 2));
  if (process.env.PSR08_SEARCH_START_AT !== 'LOCATIONS') {
    await page.goto(`${baseUrl}/properties/${fixture.id}`);
    await page.getByRole('tab', { name: 'Resources', exact: true }).click();
    await page
      .getByLabel(locale.psrSearch.query, { exact: true })
      .fill('Ocean');
    await page
      .getByRole('button', { name: locale.psrSearch.search, exact: true })
      .click();
    await page.getByText('SEA-01', { exact: true }).waitFor();
    await page.getByText('SEA-02', { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('td')).some(
          (el) => el.textContent === 'GARDEN',
        ),
    );
    check(
      'Resource search matches display label and excludes other unit',
      true,
    );
    await page.getByLabel(locale.psrSearch.sort, { exact: true }).click();
    const sortedResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/resources?') && r.url().includes('sort=capacity'),
    );
    await page
      .getByRole('option', { name: locale.psrSearch.capacity, exact: true })
      .click();
    const sortedBody = await (await sortedResponse).json();
    check(
      'Resource capacity sort returns stable filtered order',
      JSON.stringify(sortedBody.items.map((r) => r.code)) ===
        JSON.stringify(['SEA-01', 'SEA-02']),
    );
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('tbody tr')).filter((r) =>
          r.textContent?.includes('SEA-'),
        ).length === 2,
    );

    const capacityResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/resources?') &&
        new URL(r.url()).searchParams.get('min_capacity') === '4',
    );
    await page
      .getByLabel(locale.psrSearch.minCapacity, { exact: true })
      .fill('4');
    const capacityBody = await (await capacityResponse).json();
    writeFileSync(
      out + '/capacity-response.json',
      JSON.stringify(capacityBody, null, 2),
    );
    check(
      'Minimum capacity server response contains only matching unit',
      capacityBody.items.length === 1 &&
        capacityBody.items[0].code === 'SEA-02',
    );
    await page
      .getByText('SEA-02', { exact: true })
      .waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('td')).some(
          (el) => el.textContent === 'SEA-01',
        ),
    );
    check(
      'Resource minimum capacity refines filtered result',
      await page.getByText('SEA-02', { exact: true }).isVisible(),
    );
    await page.screenshot({
      path: out + '/resources-filtered.png',
      fullPage: true,
    });
  }
  await page.goto(`${baseUrl}/properties/${fixture.id}/structure`);
  await page
    .getByRole('button', { name: 'Browse children', exact: true })
    .click();
  await page
    .getByLabel(locale.psrSearch.placeQuery, { exact: true })
    .fill('Needle');
  const placesResponse = page.waitForResponse(
    (r) =>
      r.url().includes('/locations?') &&
      new URL(r.url()).searchParams.get('q') === 'Needle',
  );
  await page
    .getByRole('button', { name: locale.psrSearch.search, exact: true })
    .click();
  const desktopPlaces = await (await placesResponse).json();
  writeFileSync(
    out + '/location-response.json',
    JSON.stringify(desktopPlaces, null, 2),
  );
  check(
    'Location server search returns exactly the matching child',
    desktopPlaces.items.length === 1 &&
      desktopPlaces.items[0].name === 'Needle floor',
  );
  await page.getByText('Needle floor · FL-1', { exact: true }).waitFor();
  check(
    'Location DOM excludes the nonmatching child',
    (await page.getByText('Other floor · FL-2', { exact: true }).count()) === 0,
  );
  check('Location name search stays within selected parent', true);
  await page.screenshot({
    path: out + '/locations-filtered.png',
    fullPage: true,
  });
  await page.goto(`${baseUrl}/properties/${fixture.id}`);
  await page
    .getByRole('tab', { name: locale.resourcesTab, exact: true })
    .click();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const beforeDpr = await page.evaluate(() => window.devicePixelRatio);
  const zoom = await worker.evaluate(async (origin) => {
    const tab = (await globalThis.chrome.tabs.query({})).find((t) =>
      t.url?.startsWith(origin),
    );
    await globalThis.chrome.tabs.setZoom(tab.id, 2);
    return globalThis.chrome.tabs.getZoom(tab.id);
  }, baseUrl);
  await page.waitForFunction(
    (dpr) => window.devicePixelRatio > dpr * 1.9,
    beforeDpr,
  );
  check('Search form uses actual native200percent zoom', zoom === 2);
  const searchField = page.getByLabel(locale.psrSearch.query, { exact: true });
  await tabTo(page, searchField);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Ocean');
  const nativeResponse = page.waitForResponse(
    (r) =>
      r.url().includes('/resources?') &&
      new URL(r.url()).searchParams.get('q') === 'Ocean',
  );
  await page.keyboard.press('Enter');
  check(
    'Native200percent Enter submits the actual filtered server request',
    (await (await nativeResponse).json()).items.length === 2,
  );
  await page.getByText('SEA-01', { exact: true }).waitFor();
  check(
    'Keyboard search at native200percent returns matching units',
    await page.getByText('SEA-02', { exact: true }).isVisible(),
  );
  check(
    'Search fields fit native200percent viewport',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: out + '/search-native200.png',
    fullPage: true,
  });
  await worker.evaluate(async (origin) => {
    const tab = (await globalThis.chrome.tabs.query({})).find((t) =>
      t.url?.startsWith(origin),
    );
    await globalThis.chrome.tabs.setZoom(tab.id, 1);
  }, baseUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [option, lang, rtl] of [
    ['English', 'en-US', false],
    ['Bahasa Indonesia', 'id-ID', false],
    ['العربية', 'ar', true],
  ]) {
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
    await page.goto(`${baseUrl}/properties/${fixture.id}`);
    await page.getByRole('tab', { name: l.resourcesTab, exact: true }).click();
    const field = page.getByLabel(l.psrSearch.query, { exact: true });
    await field.waitFor();
    await tabTo(page, field);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Ocean');
    const localizedResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/resources?') &&
        new URL(r.url()).searchParams.get('q') === 'Ocean',
    );
    await page.keyboard.press('Enter');
    check(
      lang + ' Enter submits an actual filtered units request',
      (await (await localizedResponse).json()).items.length === 2,
    );
    await page.getByText('SEA-01', { exact: true }).waitFor();
    await page.getByText('SEA-02', { exact: true }).waitFor();
    const metrics = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
    }));
    metrics.controls = await page
      .locator('form input,form button,form [role="combobox"]')
      .evaluateAll((elements) =>
        elements
          .filter((el) => el.getClientRects().length)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              role: el.getAttribute('role'),
              label: el.getAttribute('aria-label'),
              left: r.left,
              right: r.right,
              width: r.width,
            };
          }),
      );
    check(
      lang + ' search critical controls fit390width',
      metrics.controls.every((r) => r.left >= -1 && r.right <= 391),
    );
    writeFileSync(
      out + '/' + lang + '-390-metrics.json',
      JSON.stringify(metrics, null, 2),
    );
    check(
      lang + ' search keyboard mobile390 and direction',
      metrics.width === 390 &&
        metrics.scrollWidth <= 391 &&
        (metrics.dir === 'rtl') === rtl,
    );
    check(
      lang + ' search labels translated',
      !(await page.locator('main').innerText()).includes('psrSearch.'),
    );
    await page.screenshot({
      path: out + '/' + lang + '-search390.png',
      fullPage: true,
    });
    await page.goto(`${baseUrl}/properties/${fixture.id}/structure`);
    await page
      .getByRole('button', { name: l.psrSetup.browseChildren, exact: true })
      .click();
    const placeField = page.getByLabel(l.psrSearch.placeQuery, { exact: true });
    await tabTo(page, placeField);
    await page.keyboard.type('Needle');
    const placesResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/locations?') &&
        new URL(r.url()).searchParams.get('q') === 'Needle',
    );
    await page.keyboard.press('Enter');
    const placesBody = await (await placesResponse).json();
    check(
      lang + ' Enter submits a selected-parent location request',
      placesBody.items.length === 1 &&
        placesBody.items[0].name === 'Needle floor',
    );
    await page.getByText('Needle floor · FL-1', { exact: true }).waitFor();
    check(
      lang + ' location search via keyboard under selected parent',
      await placeField.isVisible(),
    );
  }
  check('No browser exceptions', errors.length === 0);
} catch (error) {
  errors.push({ message: error.message, stack: error.stack });
  throw error;
} finally {
  writeFileSync(
    out + '/result.json',
    JSON.stringify({ checks, errors }, null, 2),
  );
  await context.close();
}
