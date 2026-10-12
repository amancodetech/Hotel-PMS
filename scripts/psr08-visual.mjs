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

const out =
  process.env.PSR08_BROWSER_OUT ??
  '.local/verification/PSR-08/browser-' + Date.now();
mkdirSync(out, { recursive: true });
copyFileSync('scripts/psr08-visual.mjs', out + '/source.mjs');
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
  checks.push({ name, status: ok ? 'PASS' : 'FAIL' });
  assert.ok(ok, name);
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
  writeFileSync(out + '/fixture.json', JSON.stringify(fixture, null, 2));
  if (!['E02', 'LOCALES'].includes(process.env.PSR08_START_AT)) {
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
    await page
      .getByText('Draft saved on the server.', { exact: true })
      .waitFor();
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
  }
  // E05: retain a real fetched response while client navigation changes property.
  const second = process.env.PSR08_LOCALE_PROPERTY_ID
    ? {
        id: process.env.PSR08_LOCALE_PROPERTY_ID,
        name: 'Existing synthetic locale fixture',
      }
    : await page.evaluate(async ({ tenant }) => {
        const csrf = decodeURIComponent(
          document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
        );
        const r = await fetch(`/api/v1/tenants/${tenant}/properties`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({
            code: 'SWITCH-' + Date.now(),
            name: 'PSR08 destination',
            timezone: 'Asia/Makassar',
          }),
        });
        if (!r.ok) throw Error('second fixture ' + r.status);
        return (await r.json()).property;
      }, fixture);
  writeFileSync(out + '/second-fixture.json', JSON.stringify(second, null, 2));
  if (!['E02', 'LOCALES'].includes(process.env.PSR08_START_AT)) {
    let release, captured;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const arrival = new Promise((resolve) => {
      captured = resolve;
    });
    let delayed = false;
    await page.route(
      `**/properties/${fixture.id}/setup-draft`,
      async (route) => {
        if (delayed || route.request().method() !== 'GET')
          return route.continue();
        delayed = true;
        const response = await route.fetch();
        captured();
        await held;
        await route.fulfill({ response });
      },
    );
    await page.goto(`${baseUrl}/properties/${fixture.id}/structure`, {
      waitUntil: 'domcontentloaded',
    });
    await Promise.race([
      arrival,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('delayed draft not requested')), 15000),
      ),
    ]);
    // History navigation causes the actual SPA router to change scope without destroying the page.
    await page.evaluate((id) => {
      window.history.pushState({}, '', `/properties/${id}/structure`);
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    }, second.id);
    await page.waitForFunction(
      (name) =>
        Array.from(document.querySelectorAll('input')).some(
          (el) => el.value === name,
        ),
      second.name,
    );
    release();
    await page.waitForTimeout(500);
    check(
      'E05 delayed source draft cannot overwrite destination',
      (await page
        .getByLabel('Property name', { exact: false })
        .inputValue()) === second.name &&
        !(await page.getByText(/Created 19 of 19 units/).count()),
    );
    await page.unroute(`**/properties/${fixture.id}/setup-draft`);
  } else {
    await page.goto(`${baseUrl}/properties/${second.id}/structure`);
    await page.getByLabel('Property name', { exact: false }).waitFor();
  }
  if (process.env.PSR08_START_AT !== 'LOCALES') {
    // E02/E03: independent resort groups and reversible removal of rentable parts.
    await activate(page, 'Next');
    for (const [index, type, range, capacity] of [
      [0, 'Villa', '201-201', '6'],
      [1, 'Room', '301-301', '2'],
      [2, 'Tent', '401-401', '2'],
    ]) {
      await activate(page, 'Add units');
      await page.getByLabel('Unit type', { exact: true }).nth(index).click();
      await page.getByRole('option', { name: type, exact: true }).click();
      await page
        .getByLabel('Number range', { exact: true })
        .nth(index)
        .fill(range);
      await page
        .getByLabel('Guest capacity per unit', { exact: true })
        .nth(index)
        .fill(capacity);
    }
    await page
      .getByLabel('Descriptive bedrooms per unit', { exact: true })
      .first()
      .fill('4');
    await activate(page, 'Next');
    await page.getByLabel('Booking method', { exact: true }).first().click();
    await page
      .getByRole('option', {
        name: 'Whole or rooms, with exclusive inventory',
        exact: true,
      })
      .click();
    await activate(page, 'Add separately rentable room');
    await page
      .getByLabel('Internal code (Latin letters and digits)', { exact: true })
      .fill('A');
    await page
      .getByLabel('Guest-facing name', { exact: true })
      .fill('Bedroom A');
    await page.getByLabel('Booking method', { exact: true }).first().click();
    await page
      .getByRole('option', { name: 'Whole unit only', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByText('Add separately rentable room: Bedroom A', { exact: true })
      .waitFor();
    await activate(page, 'Cancel');
    check(
      'E03 cancel preserves rentable parts',
      (await page
        .getByLabel('Guest-facing name', { exact: true })
        .inputValue()) === 'Bedroom A',
    );
    await page.getByLabel('Booking method', { exact: true }).first().click();
    await page
      .getByRole('option', { name: 'Whole unit only', exact: true })
      .click();
    await activate(page, 'Confirm action');
    await page
      .getByLabel('Guest-facing name', { exact: true })
      .waitFor({ state: 'detached' });
    const e03Facts = {
      parts: await page
        .getByLabel('Guest-facing name', { exact: true })
        .count(),
      methods: await page.getByLabel('Booking method', { exact: true }).count(),
      roleMethods: await page
        .getByRole('combobox', { name: 'Booking method', exact: true })
        .count(),
      labelledElements: await page
        .getByLabel('Booking method', { exact: true })
        .evaluateAll((els) =>
          els.map((el) => ({
            tag: el.tagName,
            role: el.getAttribute('role'),
            type: el.getAttribute('type'),
            text: el.textContent,
            value: el.value,
            outer: el.outerHTML,
          })),
        ),
      headings: await page.getByRole('heading', { level: 3 }).allTextContents(),
    };
    writeFileSync(out + '/e03-facts.json', JSON.stringify(e03Facts, null, 2));
    writeFileSync(out + '/e03-dom.html', await page.content());
    await page.screenshot({ path: out + '/e03-confirmed.png', fullPage: true });
    check(
      'E03 confirmed parts removal preserves other groups',
      (await page.getByLabel('Guest-facing name', { exact: true }).count()) ===
        0 &&
        (await page
          .getByLabel('Booking method', { exact: true })
          .and(page.getByRole('combobox'))
          .count()) === 3,
    );
    await activate(page, 'Next');
    await activate(page, 'Save draft');
    await page
      .getByText('Draft saved on the server.', { exact: true })
      .waitFor();
    await activate(page, 'Preview saved plan');
    await page
      .getByText('Unit and container records: 3', { exact: true })
      .waitFor();
    check(
      'E02 villa descriptive bedrooms and mixed groups create only three units',
      true,
    );
    const saved = await page.evaluate(
      async ({ tenant, id }) =>
        (
          await (
            await fetch(
              `/api/v1/tenants/${tenant}/properties/${id}/setup-draft`,
            )
          ).json()
        ).draft,
      { tenant: fixture.tenant, id: second.id },
    );
    writeFileSync(out + '/mixed-draft.json', JSON.stringify(saved, null, 2));
    await activate(page, 'Apply structure');
    await activate(page, 'Confirm action');
    await page
      .getByText(
        'This setup is complete. Open property management for additions and changes.',
        { exact: true },
      )
      .waitFor();
    const mixedFacts = await page.evaluate(
      async ({ tenant, id }) => ({
        resources: (
          await (
            await fetch(`/api/v1/tenants/${tenant}/properties/${id}/resources`)
          ).json()
        ).items,
        draft: (
          await (
            await fetch(
              `/api/v1/tenants/${tenant}/properties/${id}/setup-draft`,
            )
          ).json()
        ).draft,
      }),
      { tenant: fixture.tenant, id: second.id },
    );
    check(
      'E02 mixed apply preserves three independent unit types and descriptive villa bedrooms',
      mixedFacts.resources.length === 3 &&
        JSON.stringify(mixedFacts.resources.map((r) => r.type).sort()) ===
          JSON.stringify(['ROOM', 'TENT', 'VILLA']) &&
        mixedFacts.draft.completed &&
        mixedFacts.resources.find((r) => r.type === 'VILLA')?.unit_details
          ?.bedrooms_count === 4,
    );
    writeFileSync(
      out + '/mixed-result.json',
      JSON.stringify(mixedFacts, null, 2),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'E06 actual viewport width is390',
    await page.evaluate(() => window.innerWidth === 390),
  );
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
    await page.goto(`${baseUrl}/properties/${second.id}/structure?addition=1`);
    const locale = JSON.parse(
      readFileSync(`packages/i18n/src/locales/${lang}.json`, 'utf8'),
    );
    await page
      .getByRole('button', { name: locale.psrPreview.next, exact: true })
      .click();
    await page
      .getByRole('button', { name: locale.psrPreview.add, exact: true })
      .click();
    await page
      .getByLabel(locale.psrSetup.unitType ?? locale.psrPreview.type, {
        exact: true,
      })
      .click();
    for (const kind of ['SUITE_STANDALONE', 'SUITE_CONNECTED'])
      await page
        .getByRole('option', { name: locale.psrSetup[kind], exact: true })
        .waitFor();
    await page.keyboard.press('Escape');
    check(
      'E07 ' + lang + ' distinguishes standalone and connected suites',
      true,
    );
    check(
      'E07 ' + lang + ' renders without untranslated structure keys',
      !/(?:structure|psrSetup|psrPreview)\.[A-Za-z]/.test(
        await page.locator('main').innerText(),
      ),
    );
    check(
      'E06 ' + lang + ' 390px fits viewport',
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    );
    check(
      'E07 ' + lang + ' direction',
      await page.evaluate(
        (rtl) => (document.documentElement.dir === 'rtl') === rtl,
        rtl,
      ),
    );
    await page.screenshot({
      path: out + '/' + lang + '-390.png',
      fullPage: true,
    });
  }
  if (process.env.PSR08_START_AT !== 'LOCALES') {
    await page.goto(`${baseUrl}/structure-preview?propertyId=${second.id}`);
    await page.waitForURL(`**/properties/${second.id}/structure`);
    check(
      'L01 direct structure preview redirects to canonical property editor',
      true,
    );
    await page.goto(`${baseUrl}/setup-preview?propertyId=${second.id}`);
    await page.waitForURL(`**/properties/${second.id}/structure`);
    check(
      'L01 completed v2 legacy entry redirects without reopening draft',
      true,
    );
    await page.goto(baseUrl + '/preferences');
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    const legacy = await page.evaluate(async (tenant) => {
      const csrf = decodeURIComponent(
        document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
      );
      async function request(path, method, body, extra = {}) {
        const r = await fetch('/api/v1/tenants/' + tenant + path, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            ...extra,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!r.ok) throw Error('legacy fixture ' + r.status);
        return r.json();
      }
      const body = {
        property: {
          name: 'PSR08 legacy saved',
          timezone: 'Asia/Makassar',
          base_currency: 'IDR',
          types: ['ROOM'],
        },
        unit_groups: [
          {
            template_code: 'ROOM',
            rental_mode: 'EXCLUSIVE',
            pattern: '901-901',
            capacity: 2,
          },
        ],
        operations: {
          check_in: '14:00',
          check_out: '12:00',
          explicit_states: true,
        },
        pricing: { postponed: true },
      };
      const result = [];
      for (const complete of [false, true]) {
        const p = (
          await request('/properties', 'POST', {
            code: 'LEGACY-' + complete + '-' + Date.now(),
            name: body.property.name,
            timezone: 'Asia/Makassar',
          })
        ).property;
        const root = '/properties/' + p.id + '/setup-draft';
        const d = (
          await request(root, 'PUT', body, {
            'idempotency-key': window.crypto.randomUUID(),
          })
        ).draft;
        if (complete) {
          const preview = await request(root + '/preview', 'POST', {});
          await request(
            root + '/apply',
            'POST',
            { preview_version: preview.preview_version },
            {
              'idempotency-key': window.crypto.randomUUID(),
              'if-match': `"${d.draft_id}:${d.revision}"`,
            },
          );
        }
        result.push({ id: p.id, complete });
      }
      return result;
    }, fixture.tenant);
    await page.goto(`${baseUrl}/setup-preview?propertyId=${legacy[0].id}`);
    if (await page.getByTestId('setup-resume').count())
      await page.getByTestId('setup-resume').click();
    await page
      .getByLabel('Property name', { exact: true })
      .fill('PSR08 legacy changed');
    await page.getByTestId('save-draft').click();
    await page.getByText(/^Saved —/).waitFor();
    await page.reload();
    await page.getByLabel('Property name', { exact: true }).waitFor();
    check(
      'L01 v1 actual UI save and resume preserves updated name',
      (await page.getByLabel('Property name', { exact: true }).inputValue()) ===
        'PSR08 legacy changed',
    );
    await page.goto(`${baseUrl}/setup-preview?propertyId=${legacy[1].id}`);
    await page
      .getByText(
        'This setup has been applied. This draft cannot be edited again; use property settings to manage existing units.',
        { exact: true },
      )
      .waitFor();
    check(
      'L01 completed v1 remains legacy route',
      page.url().includes('/setup-preview'),
    );
    check(
      'L01 completed v1 exposes no save action',
      (await page.getByTestId('save-draft').count()) === 0,
    );
    await page.goto(`${baseUrl}/setup-preview`);
    await page
      .getByLabel('Property name', { exact: true })
      .fill('PSR08 local preserved');
    await page.getByTestId('save-draft').click();
    await page.getByText(/^Saved —/).waitFor();
    await page.reload();
    await page.getByTestId('setup-resume').click();
    check(
      'L01 local legacy draft remains resumable',
      (await page.getByLabel('Property name', { exact: true }).inputValue()) ===
        'PSR08 local preserved',
    );
  }
  writeFileSync(
    out + '/viewport.json',
    JSON.stringify(
      await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
      })),
      null,
      2,
    ),
  );
  check('no page exceptions', errors.length === 0);
  writeFileSync(
    out + '/browser.json',
    JSON.stringify({ checks, errors, fixture, second }, null, 2),
  );
  console.log(checks.length + ' checks passed');
} catch (error) {
  errors.push({ message: error.message, stack: error.stack });
  throw error;
} finally {
  writeFileSync(
    out + '/result.json',
    JSON.stringify(
      {
        checks,
        errors,
        generated_at: new Date().toISOString(),
        source: 'scripts/psr08-visual.mjs',
      },
      null,
      2,
    ),
  );
  await context.close();
}
