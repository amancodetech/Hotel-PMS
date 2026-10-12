import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const outDir = '.local/verification/P01-01';
const storageKey = 'hotel.preferences.v1';
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
  return path;
}
async function choose(page, index, name) {
  await page.getByRole('combobox').nth(index).click();
  await page.getByRole('option', { name, exact: true }).click();
  await page
    .locator('[role="listbox"]')
    .waitFor({ state: 'detached' })
    .catch(() => undefined);
  await page.waitForTimeout(250);
}
async function preferences(page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    storageKey,
  );
}
async function overflow(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const documentElement = document.documentElement;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right > viewport + 1 || box.left < -1) {
        const className = String(element.className)
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        offenders.push(
          `${element.tagName.toLowerCase()}${className ? `.${className}` : ''}@${Math.round(box.left)}..${Math.round(box.right)}`,
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

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'id-ID',
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

try {
  await page.goto(`${baseUrl}/preferences`);
  await page.locator('main h1').waitFor({ state: 'visible' });
  check(
    'default preference id-ID is LTR',
    (await page.getAttribute('html', 'lang')) === 'id-ID' &&
      (await page.getAttribute('html', 'dir')) === 'ltr',
  );
  const initial = await preferences(page);
  check(
    'defaults applied when storage is empty',
    initial === null &&
      (await page.getByRole('combobox').nth(1).textContent())?.includes(
        'IDR',
      ) &&
      (await page.getByRole('combobox').nth(2).textContent())?.includes(
        'Asia/Makassar',
      ),
    JSON.stringify(initial),
  );
  await choose(page, 0, 'العربية');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  check(
    'arabic RTL heading',
    (await page.locator('main h1').first().textContent())?.trim() ===
      'التفضيلات' && (await page.getAttribute('html', 'lang')) === 'ar',
  );
  await shot(page, 'preferences-1280x800-ar');
  await page.reload();
  await page.locator('main h1').waitFor({ state: 'visible' });
  const persisted = await preferences(page);
  check(
    'language persists after reload',
    (await page.getAttribute('html', 'dir')) === 'rtl' &&
      persisted?.language === 'ar' &&
      persisted?.currency === 'IDR' &&
      persisted?.timezone === 'Asia/Makassar',
    JSON.stringify(persisted),
  );
  await choose(page, 0, 'English');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  check(
    'english LTR heading',
    (await page.locator('main h1').first().textContent())?.trim() ===
      'Preferences' && (await page.getAttribute('html', 'lang')) === 'en-US',
  );
  await choose(page, 0, 'Bahasa Indonesia');
  await page.waitForFunction(() => document.documentElement.lang === 'id-ID');
  check(
    'indonesian heading',
    (await page.locator('main h1').first().textContent())?.trim() ===
      'Preferensi',
  );

  await choose(page, 0, 'English');
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await choose(page, 2, 'Asia/Jakarta');
  await page.waitForFunction(
    () => document.querySelector('dd')?.textContent?.length > 0,
  );
  const jakarta = await page.locator('dd').first().textContent();
  await choose(page, 2, 'Asia/Jayapura');
  const jayapura = await page.locator('dd').first().textContent();
  check(
    'timezone changes rendered instant',
    Boolean(jakarta && jayapura && jakarta !== jayapura),
    `${jakarta} / ${jayapura}`,
  );
  await choose(page, 1, 'USD');
  const usd = await page.locator('.money-preview').textContent();
  check('USD preview', /\$/.test(usd ?? ''), usd ?? '');
  await choose(page, 1, 'IDR');
  const idr = await page.locator('.money-preview').textContent();
  check('IDR preview', /\bIDR\b/.test(idr ?? ''), idr ?? '');
  const amount = page.getByRole('textbox');
  await amount.fill('1e3');
  const invalid = await amount.getAttribute('aria-invalid');
  const invalidPreview = await page.locator('.money-preview').textContent();
  check(
    'invalid amount rejected in UI',
    invalid === 'true' && invalidPreview?.trim() === '-',
    `aria-invalid=${invalid}`,
  );
  await shot(page, 'preferences-invalid-amount-en');
  await amount.fill('12.50');
  check(
    'valid amount accepted in UI',
    (await amount.getAttribute('aria-invalid')) === 'false' &&
      (await page.locator('.money-preview').textContent())?.includes('12.50'),
  );

  await page.goto(`${baseUrl}/`);
  await page.locator('.services').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelectorAll('.dependency-state.up').length === 6,
  );
  await page.keyboard.press('Tab');
  const focusClass = await page.evaluate(
    () => document.activeElement?.className ?? '',
  );
  check(
    'skip link receives first tab focus',
    focusClass.includes('skip-link') &&
      (await page.locator('.skip-link').boundingBox())?.y >= 0,
    focusClass,
  );
  await shot(page, 'keyboard-skip-link-focus');
  await page.keyboard.press('Enter');
  check(
    'skip link moves focus to main',
    (await page.evaluate(() => document.activeElement?.id)) === 'main',
  );
  await page.keyboard.press('Tab');
  check(
    'keyboard continues inside main on an interactive control',
    await page.evaluate(
      () =>
        document.activeElement?.closest('#main') !== null &&
        document.activeElement?.tagName === 'BUTTON',
    ),
    await page.evaluate(() => document.activeElement?.tagName ?? ''),
  );
  await page.keyboard.press('Shift+Tab');
  check(
    'reverse keyboard traversal reaches navigation link',
    await page.evaluate(
      () =>
        document.activeElement?.tagName === 'A' &&
        document.activeElement?.closest('.sidebar') !== null,
    ),
    await page.evaluate(
      () =>
        `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('href') ?? ''}`,
    ),
  );

  const setPreference = async (language) => {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: storageKey,
      value: JSON.stringify({
        language,
        currency: 'IDR',
        timezone: 'Asia/Makassar',
      }),
    });
    await page.reload();
    await page.locator('main h1').waitFor({ state: 'visible' });
  };
  await setPreference('ar');
  const rtlSidebar = await page.locator('.sidebar').boundingBox();
  const rtlMain = await page.locator('main').boundingBox();
  check(
    'RTL places sidebar at the inline start (right)',
    Boolean(
      rtlSidebar && rtlMain && rtlSidebar.x > rtlMain.x + rtlMain.width / 3,
    ),
    `sidebar.x=${rtlSidebar?.x} main.x=${rtlMain?.x}`,
  );
  await setPreference('en-US');
  const ltrSidebar = await page.locator('.sidebar').boundingBox();
  const ltrMain = await page.locator('main').boundingBox();
  check(
    'LTR places sidebar at the left',
    Boolean(ltrSidebar && ltrSidebar.x < (ltrMain?.x ?? 0)),
    `sidebar.x=${ltrSidebar?.x} main.x=${ltrMain?.x}`,
  );

  const viewports = [
    ['1440x900', 1440, 900],
    ['1280x800', 1280, 800],
    ['390x844', 390, 844],
    ['320x740', 320, 740],
  ];
  for (const [label, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await setPreference('id-ID');
    await page.goto(`${baseUrl}/`);
    await page.locator('.services').waitFor({ state: 'visible' });
    const homeOverflow = await overflow(page);
    check(
      `no horizontal overflow home ${label}`,
      homeOverflow.documentDelta <= 0 &&
        homeOverflow.bodyDelta <= 0 &&
        homeOverflow.offenders.length === 0,
      JSON.stringify(homeOverflow),
    );
    if (width <= 480) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(200);
      const scrolled = await page.evaluate(() => window.scrollY);
      check(
        `scrolling works home ${label}`,
        scrolled > 0,
        `scrollY=${scrolled}`,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await shot(page, `home-${label}-id`);
    await page.goto(`${baseUrl}/preferences`);
    await page.locator('.preferences-layout').waitFor({ state: 'visible' });
    const prefsOverflow = await overflow(page);
    check(
      `no horizontal overflow preferences ${label}`,
      prefsOverflow.documentDelta <= 0 &&
        prefsOverflow.bodyDelta <= 0 &&
        prefsOverflow.offenders.length === 0,
      JSON.stringify(prefsOverflow),
    );
    await shot(page, `preferences-${label}-id`);
  }
  for (const [label, width, height] of [
    ['1440x900', 1440, 900],
    ['390x844', 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await setPreference('ar');
    await page.goto(`${baseUrl}/`);
    await page.locator('.services').waitFor({ state: 'visible' });
    const rtlOverflow = await overflow(page);
    check(
      `no horizontal overflow home ${label} ar`,
      rtlOverflow.documentDelta <= 0 &&
        rtlOverflow.bodyDelta <= 0 &&
        rtlOverflow.offenders.length === 0,
      JSON.stringify(rtlOverflow),
    );
    await shot(page, `home-${label}-ar`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setPreference('en-US');
  await page.goto(`${baseUrl}/`);
  await page.locator('.services').waitFor({ state: 'visible' });
  await shot(page, 'home-1440x900-en');
  await page.goto(`${baseUrl}/preferences`);
  await page.locator('.preferences-layout').waitFor({ state: 'visible' });
  await shot(page, 'preferences-1440x900-en');

  const happyPathErrors = [...pageErrors];
  check(
    'no uncaught page errors on happy path',
    happyPathErrors.length === 0,
    happyPathErrors.join(' | '),
  );
  const happyPathConsole = consoleErrors.filter(
    (text) => !/Download the React DevTools/.test(text),
  );
  check(
    'no console errors on happy path',
    happyPathConsole.length === 0,
    happyPathConsole.slice(0, 3).join(' | '),
  );

  await setPreference('id-ID');
  await page.route('**/api/v1/system/ready', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.route('**/worker-health', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto(`${baseUrl}/`);
  const loading = await page
    .locator('[role="progressbar"]')
    .first()
    .isVisible()
    .catch(() => false);
  check('loading indicator visible while checking', loading);
  await shot(page, 'state-loading');
  await page.waitForFunction(
    () => document.querySelectorAll('.dependency-state.up').length === 6,
    null,
    { timeout: 20000 },
  );
  await page.unroute('**/api/v1/system/ready');
  await page.unroute('**/worker-health');

  await page.route('**/api/v1/system/ready', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'errors.DEPENDENCY_UNAVAILABLE',
        correlation_id: 'synthetic',
        details: {
          status: 'unavailable',
          checked_at: new Date().toISOString(),
          checks: { database: 'down', redis: 'up', identity: 'up' },
        },
      }),
    }),
  );
  await page.goto(`${baseUrl}/`);
  await page.locator('.services').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelectorAll('.dependency-state.down').length === 1,
  );
  check('dependency failure shown without false success', true);
  await shot(page, 'state-dependency-down');
  await page.unroute('**/api/v1/system/ready');

  await page.route('**/api/v1/system/ready', (route) => route.abort());
  await page.goto(`${baseUrl}/`);
  await page.locator('.services').waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    document.body.textContent.includes('Status tidak dapat diambil'),
  );
  check('network failure shows retry, no raw error', true);
  await shot(page, 'state-request-error');
  await page.unroute('**/api/v1/system/ready');
  await page.getByRole('button', { name: 'Periksa kembali API' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.dependency-state.up').length === 6,
  );
  check('retry recovers after failure', true);

  await context.setOffline(true);
  await page.waitForFunction(() =>
    document.body.textContent.includes('Koneksi jaringan terputus'),
  );
  check('offline banner appears', true);
  await shot(page, 'state-offline');
  await context.setOffline(false);
  await page.waitForFunction(
    () => !document.body.textContent.includes('Koneksi jaringan terputus'),
  );
  check('offline banner clears when online', true);

  await page.goto(`${baseUrl}/missing`).catch(() => undefined);
  await page.waitForFunction(() =>
    document.body.textContent.includes('Halaman tidak ditemukan'),
  );
  await shot(page, 'state-not-found');
  await page.getByRole('link', { name: 'Kembali ke status' }).click();
  check(
    'unknown route returns to status',
    new URL(page.url()).pathname === '/',
    page.url(),
  );

  const report = {
    scope: 'P01-01',
    captured_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: `chromium ${browser.version()}`,
    engine: 'playwright',
    viewports: viewports.map(([label]) => label),
    checks,
    failures,
    screenshots,
    page_errors: pageErrors,
    console_errors: consoleErrors,
  };
  writeFileSync(
    `${outDir}/report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `\nP01-01: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
