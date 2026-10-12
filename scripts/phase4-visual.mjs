import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const outDir = '.local/verification/P04-04';
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

const runId = String(Date.now()).slice(-6);
const propertyCode = `P04-${runId}`;

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
  check('admin signs in with MFA for property setup', true);

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New property' }).waitFor();
  await shot(page, 'p04-properties-empty-1440x900');

  await page.getByRole('button', { name: 'New property' }).click();
  await page.getByLabel('Property code').fill(propertyCode);
  await page.getByLabel('Property name').fill('P04 Visual Property');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Search properties by name or code').fill(propertyCode);
  await page
    .locator('table tbody tr', { hasText: propertyCode })
    .first()
    .waitFor();
  check('property created from the transport UI', true);
  await shot(page, 'p04-properties-created-1440x900');

  await page
    .locator('table tbody tr', { hasText: propertyCode })
    .getByRole('link', { name: 'P04 Visual Property' })
    .click();
  await page.getByRole('tab', { name: 'Locations' }).waitFor();
  check('property setup tabs render', true);

  await page.getByRole('tab', { name: 'Locations' }).click();
  await page.getByRole('button', { name: 'New location' }).click();
  await page.getByLabel('Location code').fill('L-01');
  await page.getByLabel('Location name').fill('Main block');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('table tbody tr', { hasText: 'L-01' }).waitFor();
  check('location created in the setup screen', true);

  await page.getByRole('tab', { name: 'Resources' }).click();
  await page.getByRole('button', { name: 'New resource' }).click();
  await page.getByLabel('Resource code').fill('R-101');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('table tbody tr', { hasText: 'R-101' }).waitFor();
  check('resource created in the setup screen', true);
  await shot(page, 'p04-resources-1440x900');

  await page.getByRole('tab', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Product code').fill('PROD-1');
  await page.getByLabel('Product name').fill('Standard room');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('table tbody tr', { hasText: 'PROD-1' }).waitFor();
  const productRow = page.locator('table tbody tr', { hasText: 'PROD-1' });
  await productRow.getByRole('button', { name: 'Candidates' }).click();
  const candidateDialog = page.getByRole('dialog');
  await candidateDialog.getByLabel('Add candidate resource').click();
  await page.getByRole('option', { name: 'R-101' }).click();
  await candidateDialog.getByRole('button', { name: 'Add' }).click();
  await candidateDialog
    .locator('table tbody tr', { hasText: 'R-101' })
    .waitFor();
  check('candidate resource linked to the product', true);
  await candidateDialog.getByRole('button', { name: 'Close' }).click();
  await productRow.getByRole('button', { name: 'Activate' }).click();
  await productRow.getByText('Active').waitFor();
  check('product activated with a live candidate', true);
  await shot(page, 'p04-products-1440x900');

  await page.getByRole('tab', { name: 'Compositions' }).click();
  await page.getByRole('button', { name: 'New composition' }).click();
  const compositionDialog = page.getByRole('dialog');
  await compositionDialog.getByLabel('Product').click();
  await page.getByRole('option', { name: /PROD-1/ }).click();
  await compositionDialog.getByLabel('Effective from').fill('2026-10-01');
  await compositionDialog.getByLabel('Effective to').fill('2026-12-31');
  await compositionDialog.getByLabel('Resources').click();
  await page.getByRole('option', { name: 'R-101' }).click();
  await page.keyboard.press('Escape');
  await compositionDialog.getByRole('button', { name: 'Save' }).click();
  await page.locator('table tbody tr', { hasText: '2026-10-01' }).waitFor();
  check('draft composition stored from the setup screen', true);
  await page
    .locator('table tbody tr', { hasText: '2026-10-01' })
    .getByRole('button', { name: 'Activate' })
    .click();
  const reasonDialog = page.getByRole('dialog');
  await reasonDialog.getByLabel('Reason').fill('visual acceptance activation');
  await reasonDialog.getByRole('button', { name: 'Activate' }).click();
  await page
    .locator('table tbody tr', { hasText: '2026-10-01' })
    .getByText('Active')
    .waitFor();
  check('composition activated and flattened through the UI', true);
  await shot(page, 'p04-compositions-1440x900');

  await page.getByRole('tab', { name: 'Channel drafts' }).click();
  await page.getByRole('button', { name: 'New connection (draft)' }).click();
  const connectionDialog = page.getByRole('dialog');
  await connectionDialog.getByLabel('Provider').fill('channex');
  await connectionDialog.getByLabel('Channel').fill('tiket-com');
  await connectionDialog.getByLabel('Secret reference').fill('secret:visual');
  await connectionDialog.getByRole('button', { name: 'Save' }).click();
  await page.locator('table tbody tr', { hasText: 'channex' }).waitFor();
  const connectionRow = page.locator('table tbody tr', { hasText: 'channex' });
  await connectionRow.getByRole('button', { name: 'Mappings' }).click();
  const mappingDialog = page.getByRole('dialog');
  await mappingDialog.getByLabel('External room ref').fill('EXT-101');
  await mappingDialog.getByLabel('External rate ref').fill('RATE-1');
  await mappingDialog.getByLabel('Internal product').click();
  await page.getByRole('option', { name: 'PROD-1' }).click();
  await mappingDialog.getByRole('button', { name: 'Save mapping' }).click();
  await mappingDialog
    .locator('table tbody tr', { hasText: 'EXT-101' })
    .waitFor();
  check('draft mapping saved and shown as draft', true);
  await mappingDialog.getByRole('button', { name: 'Close' }).click();
  const channelBody = (await page.locator('body').textContent()) ?? '';
  check(
    'secret references are never rendered back to the browser',
    !channelBody.includes('secret:visual'),
  );
  await shot(page, 'p04-channel-drafts-1440x900');

  // RTL and Arabic rendering for the new screens.
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية' }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.locator('table').first().waitFor();
  await shot(page, 'p04-properties-ar-rtl');
  const rtlOverflow = await overflow(page);
  check(
    'no horizontal overflow on Arabic properties page',
    rtlOverflow.documentDelta <= 0 &&
      rtlOverflow.bodyDelta <= 0 &&
      rtlOverflow.offenders.length === 0,
    JSON.stringify(rtlOverflow),
  );
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');

  // Viewport sweep on the setup screen.
  for (const [label, width, height] of [
    ['1440x900', 1440, 900],
    ['390x844', 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${baseUrl}/properties`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('table').first().waitFor();
    const viewportOverflow = await overflow(page);
    check(
      `no horizontal overflow properties ${label}`,
      viewportOverflow.documentDelta <= 0 &&
        viewportOverflow.bodyDelta <= 0 &&
        viewportOverflow.offenders.length === 0,
      JSON.stringify(viewportOverflow),
    );
    await shot(page, `p04-properties-${label}-en`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Members without property permission see the forbidden panel.
  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const memberPage = await signIn(
    memberContext,
    'viewer-v',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await memberPage.goto(`${baseUrl}/properties`, {
    waitUntil: 'domcontentloaded',
  });
  await memberPage.locator('#main').first().waitFor({ timeout: 20000 });
  await memberPage.waitForTimeout(1500);
  const memberUrl = memberPage.url();
  const memberBody = (await memberPage.locator('body').textContent()) ?? '';
  check(
    'member sees the forbidden panel instead of property setup',
    memberBody.includes('The server rejected') ||
      memberBody.includes('Server menolak') ||
      memberBody.includes('الخادم رفض'),
    `url=${memberUrl} text=${memberBody.slice(0, 160)}`,
  );
  await shot(memberPage, 'p04-forbidden-properties-member');
  await memberContext.close();

  const happyPathErrors = pageErrors.filter(
    (text) => !/Failed to load resource/.test(text),
  );
  check(
    'no uncaught page errors on the Phase 4 happy path',
    happyPathErrors.length === 0,
    happyPathErrors.slice(0, 3).join(' | '),
  );
  const happyConsole = consoleErrors.filter(
    (text) =>
      !/Download the React DevTools/.test(text) &&
      !/status of 40[0-9]/.test(text),
  );
  check(
    'no console errors on the Phase 4 happy path',
    happyConsole.length === 0,
    happyConsole.slice(0, 3).join(' | '),
  );

  const report = {
    scope: 'P04-04',
    captured_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: `chromium ${browser.version()}`,
    engine: 'playwright',
    property_code: propertyCode,
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
    `\nP04-04 visual: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
