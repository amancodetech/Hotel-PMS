import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const outDir = '.local/verification/P03-06';
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

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
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
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href^="/api/v1/auth/login"]');
  check('anonymous users land on the sign-in screen', true);
  await shot(page, 'p03-login-id');

  await page.click('a[href^="/api/v1/auth/login"]');
  await page.waitForURL(/\/realms\//, { timeout: 20000 });
  check('sign-in redirects to the local identity provider', true);
  await page.screenshot({ path: `${outDir}/p03-keycloak-login.png` });
  screenshots.push(`${outDir}/p03-keycloak-login.png`);
  await page.fill('#username', 'owner-a');
  await page.fill('#password', process.env.KEYCLOAK_TEST_USER_PASSWORD);
  await page.click('#kc-login');
  await page.waitForURL(new RegExp(baseUrl.replaceAll('.', '\\.')), {
    timeout: 20000,
  });
  await page.locator('.user-chip').waitFor({ state: 'visible' });
  check(
    'authenticated shell shows the user and active tenant',
    (await page.locator('.user-email').textContent())?.includes('owner-a'),
  );
  check(
    'tenant chip matches the provisioned tenant',
    (await page.locator('.tenant-menu').textContent())?.includes('Nusantara'),
  );
  const storage = await page.evaluate(() => ({
    local: Object.entries(globalThis.localStorage),
    session: Object.entries(globalThis.sessionStorage),
  }));
  const stored = JSON.stringify(storage);
  check(
    'no tokens in browser storage',
    !/eyJ[A-Za-z0-9_-]{10,}|refresh_token|access_token|id_token/.test(stored),
    stored.slice(0, 120),
  );
  check(
    'session cookie is not readable from JavaScript',
    !(await page.evaluate(() => document.cookie)).includes('hotel_session'),
  );
  await page.goto(`${baseUrl}/members`, { waitUntil: 'domcontentloaded' });
  await page.locator('table').first().waitFor();
  const memberRows = await page.locator('table tbody tr').count();
  check(
    'members table lists the synthetic memberships',
    memberRows >= 5,
    `${memberRows} rows`,
  );
  await shot(page, 'p03-members-1440x900-id');

  await page.goto(`${baseUrl}/roles`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Peran' }).waitFor();
  await shot(page, 'p03-roles-1440x900-id');
  await page.getByRole('tab', { name: 'Pemberian' }).click();
  await shot(page, 'p03-grants-1440x900-id');
  await page.getByRole('tab', { name: 'Persetujuan' }).click();
  await shot(page, 'p03-approvals-1440x900-id');

  await page.goto(`${baseUrl}/audit`, { waitUntil: 'domcontentloaded' });
  await page.locator('table').first().waitFor();
  check(
    'audit table renders administrative events',
    (await page.locator('table tbody tr').count()) > 0,
  );
  await shot(page, 'p03-audit-1440x900-id');

  // Language switching, direction and persistence.
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية' }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.reload();
  await page.locator('.preferences-layout').waitFor();
  check(
    'Arabic RTL persists after reload',
    (await page.getAttribute('html', 'dir')) === 'rtl' &&
      (await page.getAttribute('html', 'lang')) === 'ar',
  );
  await page.goto(`${baseUrl}/members`, { waitUntil: 'domcontentloaded' });
  await page.locator('table').first().waitFor();
  await shot(page, 'p03-members-1440x900-ar-rtl');
  const rtlOverflow = await overflow(page);
  check(
    'no horizontal overflow on Arabic members page',
    rtlOverflow.documentDelta <= 0 && rtlOverflow.bodyDelta <= 0,
    JSON.stringify(rtlOverflow),
  );
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await page.goto(`${baseUrl}/roles`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Roles' }).waitFor();
  await shot(page, 'p03-roles-1440x900-en');

  // Keyboard navigation.
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/properties');
  await page.getByRole('heading', { level: 1, name: 'Properties' }).waitFor();
  await page.locator('.skip-link').waitFor({ state: 'attached' });
  await page.keyboard.press('Tab');
  check(
    'skip link receives first keyboard focus',
    await page.evaluate(() =>
      document.activeElement?.className?.includes('skip-link'),
    ),
  );
  await page.keyboard.press('Enter');
  check(
    'skip link moves focus to main',
    (await page.evaluate(() => document.activeElement?.id)) === 'main',
  );
  await page.keyboard.press('Tab');
  check(
    'keyboard continues on an interactive control inside main',
    await page.evaluate(
      () => document.activeElement?.closest('#main') !== null,
    ),
  );

  // Viewports.
  const viewports = [
    ['1440x900', 1440, 900],
    ['1280x720', 1280, 720],
    ['390x844', 390, 844],
    ['360x800', 360, 800],
  ];
  for (const [label, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(`${baseUrl}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('table').first().waitFor();
    const mobileOverflow = await overflow(page);
    check(
      `no horizontal overflow members ${label}`,
      mobileOverflow.documentDelta <= 0 &&
        mobileOverflow.bodyDelta <= 0 &&
        mobileOverflow.offenders.length === 0,
      JSON.stringify(mobileOverflow),
    );
    await shot(page, `p03-members-${label}-en`);
  }
  check(
    'mobile viewports are browser simulations, not real devices',
    true,
    'Playwright Chromium emulation only',
  );

  // Forbidden state for a member without role administration permission.
  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const memberPage = await signIn(
    memberContext,
    'viewer-v',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await memberPage.goto(`${baseUrl}/roles`, { waitUntil: 'domcontentloaded' });
  await memberPage.locator('[role="status"]').first().waitFor();
  const memberText = (await memberPage.locator('body').textContent()) ?? '';
  check(
    'member sees the forbidden panel instead of role administration',
    memberText.includes('The server rejected') ||
      memberText.includes('Server menolak') ||
      memberText.includes('الخادم رفض'),
  );
  await shot(memberPage, 'p03-forbidden-roles-member');
  await memberContext.close();

  // MFA login shows the MFA indicator.
  const mfaContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const mfaPage = await signIn(
    mfaContext,
    'mfa-a',
    process.env.KEYCLOAK_MFA_USER_PASSWORD,
    process.env.KEYCLOAK_MFA_TOTP_KEY,
  );
  check(
    'MFA login displays the second-factor indicator',
    (await mfaPage.locator('.user-chip').textContent())?.includes('MFA'),
  );
  await shot(mfaPage, 'p03-mfa-user-1440x900-en');
  await mfaContext.close();

  // Logout ends both the local session and the Keycloak session.
  await page.goto(`${baseUrl}/members`, { waitUntil: 'domcontentloaded' });
  await page.locator('table').first().waitFor();
  await Promise.all([
    page.waitForURL(/login-actions\/logout|127\.0\.0\.1:5173\/login/, {
      timeout: 20000,
    }),
    page.getByRole('button', { name: /Sign out|Keluar|تسجيل الخروج/ }).click(),
  ]);
  await page.waitForSelector('a[href^="/api/v1/auth/login"]', {
    timeout: 20000,
  });
  check('logout clears the session and returns to sign-in', true);
  await shot(page, 'p03-logout-login-en');

  const happyPathErrors = pageErrors.filter(
    (text) => !/Failed to load resource/.test(text),
  );
  check(
    'no uncaught page errors on the Phase 3 happy path',
    happyPathErrors.length === 0,
    happyPathErrors.slice(0, 3).join(' | '),
  );
  const happyConsole = consoleErrors.filter(
    (text) => !/Download the React DevTools/.test(text),
  );
  check(
    'no console errors on the Phase 3 happy path',
    happyConsole.length === 0,
    happyConsole.slice(0, 3).join(' | '),
  );

  const report = {
    scope: 'P03-06',
    captured_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: `chromium ${browser.version()}`,
    engine: 'playwright',
    viewports: viewports.map(([label]) => label),
    device_note:
      'Mobile sizes are Playwright browser emulation; no physical device testing.',
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
    `\nP03-06 visual: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
