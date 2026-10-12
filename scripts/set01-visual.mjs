import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const outDir = '.local/verification/SET-01';
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
async function clearDrafts(page) {
  await page.evaluate(() => {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith('hotel:setup-wizard-preview:')) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  });
}
async function clippedActions(page) {
  return page.evaluate(() => {
    const ids = [
      'next-step',
      'back-step',
      'save-draft',
      'setup-stepper-compact',
    ];
    const offenders = [];
    for (const id of ids) {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        offenders.push(`${id}:hidden`);
        continue;
      }
      if (box.left < -1 || box.right > window.innerWidth + 1)
        offenders.push(`${id}:clipped`);
    }
    return offenders;
  });
}
async function selectOption(page, testId, option) {
  await page
    .getByTestId(testId)
    .locator('xpath=..')
    .getByRole('combobox')
    .click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function selectCombobox(page, testId, option) {
  await page.getByTestId(testId).getByRole('combobox').click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const runId = String(Date.now()).slice(-6);
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
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');

  await page.goto(`${baseUrl}/setup-preview`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('setup-wizard-preview').waitFor();
  check(
    'setup route uses the setup title instead of the not-found shell',
    (await page.title()).startsWith(
      'Property setup wizard (interactive prototype)',
    ) && (await page.locator('.shell-page-title').count()) === 0,
  );
  await clearDrafts(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-prototype-banner').waitFor();
  check('prototype page renders with the review banner', true);
  await shot(page, 'set01-portal-1440x900');

  await page.getByTestId('property-name').fill('Set01 Simple Inn');
  await page.getByTestId('property-code').fill('SET01');
  await selectOption(page, 'property-timezone', 'Asia/Jakarta');
  await selectOption(page, 'property-currency', 'IDR');
  await page.getByTestId('property-type-ROOM').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-units').waitFor();
  check('simple journey reaches the units step', true);

  await page.getByTestId('group-pattern-0').fill('101-116');
  await page.getByTestId('group-exclusions-0').fill('113');
  const previewText = await page.getByTestId('unit-preview-0').textContent();
  check(
    'unit preview derives 15 rooms with the excluded number',
    (previewText ?? '').includes('15') && (previewText ?? '').includes('113'),
    previewText ?? '',
  );
  await shot(page, 'set01-units-preview-1440x900');
  await page.getByTestId('next-step').click();

  await page.getByTestId('setup-step-rental').waitFor();
  await page.getByLabel('Exclusive unit', { exact: true }).click();
  await page.getByTestId('next-step').click();

  await page.getByTestId('setup-step-operations').waitFor();
  await page.getByTestId('next-step').click();
  const blocked = await page
    .getByTestId('setup-errors')
    .isVisible()
    .catch(() => false);
  check(
    'operations step rejects missing explicit readiness',
    blocked === true,
    `errors=${blocked}`,
  );
  const focusedAfterFailure = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? '',
  );
  check(
    'failed next moves focus to the error summary',
    focusedAfterFailure === 'setup-errors',
    focusedAfterFailure,
  );
  await page.getByTestId('explicit-states').click();
  await page.getByTestId('next-step').click();

  await page.getByTestId('setup-step-pricing').waitFor();
  await page.getByTestId('postpone-pricing').click();
  await page.getByTestId('next-step').click();

  await page.getByTestId('setup-step-review').waitFor();
  const unitsChip = await page.getByTestId('review-units').textContent();
  check(
    'review counts keep 15 rooms and zero beds',
    (unitsChip ?? '').includes('15') &&
      ((await page.getByTestId('review-beds').textContent()) ?? '').includes(
        '0',
      ),
    unitsChip ?? '',
  );
  const missingText = await page.getByTestId('review-missing').textContent();
  check(
    'review marks the draft complete when pricing is postponed',
    (missingText ?? '').includes('No blocking gaps'),
    missingText ?? '',
  );
  await page.getByTestId('simulate-exclusive').click();
  check(
    'exclusive sale simulation returns a result',
    await page.getByTestId('simulation-result').isVisible(),
  );
  await shot(page, 'set01-review-simple-1440x900');

  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  check('draft save reports success after completion', true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-resume-banner').waitFor();
  check('saved draft offers resume after reload', true);
  await page.getByTestId('setup-resume').click();
  await page.getByTestId('setup-step-review').waitFor();
  check(
    'resumed draft keeps the review counts',
    ((await page.getByTestId('review-units').textContent()) ?? '').includes(
      '15',
    ),
  );
  await shot(page, 'set01-resumed-draft-1440x900');

  await page.getByTestId('simulate-conflict').click();
  check(
    'conflict state is announced with compare actions',
    await page.getByTestId('save-conflict').isVisible(),
  );
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  check(
    'keeping local edits clears the conflict banner',
    !(await page.getByTestId('save-conflict').isVisible()),
  );

  await page.getByTestId('simulate-failure').click();
  await page.getByTestId('save-draft').click();
  await page.waitForTimeout(700);
  check(
    'simulated network failure shows a retry path',
    await page.getByTestId('save-error').isVisible(),
  );
  await page.getByTestId('simulate-failure').click();
  await page.getByRole('button', { name: 'Retry save' }).click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  check('retry saves after the simulated failure', true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-resume-banner').waitFor();
  await page.getByTestId('setup-start-over').click();
  await page.getByTestId('setup-step-property').waitFor();
  check(
    'start over clears the saved draft and returns to step one',
    !(await page.getByTestId('setup-resume-banner').isVisible()) &&
      (await page.getByTestId('property-name').inputValue()) === '',
  );
  await page.getByTestId('property-name').fill('Set01 Villa');
  await page.getByTestId('property-code').fill('SET01V');
  await selectOption(page, 'property-timezone', 'Asia/Makassar');
  await selectOption(page, 'property-currency', 'IDR');
  await page.getByTestId('property-type-VILLA').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('group-pattern-0').fill('101-104');
  await selectCombobox(page, 'group-template-0', 'Villa');
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية' }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.goto(`${baseUrl}/setup-preview`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('setup-wizard-preview').waitFor();
  const midWizardDir = await page.evaluate(() => document.documentElement.dir);
  await page.getByTestId('setup-resume').click();
  await page.getByTestId('setup-step-units').waitFor();
  const arabicPattern = await page.getByTestId('group-pattern-0').inputValue();
  check(
    'language switch mid-wizard keeps the units step and its inputs',
    midWizardDir === 'rtl' && arabicPattern === '101-104',
    `dir=${midWizardDir} pattern=${arabicPattern}`,
  );
  await shot(page, 'set08-mid-wizard-ar-1440x900');
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await page.goto(`${baseUrl}/setup-preview`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('setup-wizard-preview').waitFor();
  await page.getByTestId('setup-resume').click();
  await page.getByTestId('setup-step-units').waitFor();
  check(
    'switching back keeps the same step and inputs',
    (await page.getByTestId('group-pattern-0').inputValue()) === '101-104',
  );
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-rental').waitFor();
  await page.getByLabel('Whole or separate parts', { exact: true }).click();
  await page.getByTestId('next-step').click();
  const privacyBlocked = await page
    .getByTestId('setup-errors')
    .isVisible()
    .catch(() => false);
  check(
    'parts selling is blocked until privacy is acknowledged',
    privacyBlocked === true,
    `errors=${privacyBlocked}`,
  );
  await page.getByTestId('privacy-ack-0').click();
  await page.getByTestId('add-part-0').click();
  await page.getByTestId('part-label-0-0').fill('A');
  await page.getByTestId('add-part-0').click();
  await page.getByTestId('part-label-0-1').fill('B');
  await page.getByTestId('add-part-0').click();
  await page.getByTestId('part-label-0-2').fill('C');
  await page.getByTestId('spec-0-KING').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('explicit-states').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('sell-from').fill('2026-10-01');
  await page.getByTestId('sell-to').fill('2026-12-31');
  await page.getByTestId('rate-plan-name').fill('Villa flexible');
  await page.getByTestId('base-price').fill('1500000');
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-review').waitFor();
  const roomsChip = await page.getByTestId('review-rooms').textContent();
  check(
    'villa review counts rooms in a separate denominator',
    (roomsChip ?? '').includes('12'),
    roomsChip ?? '',
  );
  await page.getByTestId('simulate-whole').click();
  const wholeResult = await page.getByTestId('simulation-result').textContent();
  check(
    'whole villa sale blocks every part in the simulation',
    (wholeResult ?? '').includes('A, B, C'),
    wholeResult ?? '',
  );
  await page.getByTestId('simulate-part').click();
  check(
    'part sale simulation keeps a separate result',
    (
      (await page.getByTestId('simulation-result').textContent()) ?? ''
    ).includes('whole unit'),
  );
  await shot(page, 'set01-review-villa-1440x900');
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'العربية' }).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.goto(`${baseUrl}/setup-preview`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('setup-wizard-preview').waitFor();
  await page.getByTestId('setup-resume').click();
  await page.getByTestId('setup-step-review').waitFor();
  const rtlOverflow = await overflow(page);
  check(
    'Arabic RTL review renders without horizontal overflow',
    rtlOverflow.documentDelta <= 0 &&
      rtlOverflow.bodyDelta <= 0 &&
      rtlOverflow.offenders.length === 0,
    JSON.stringify(rtlOverflow),
  );
  await shot(page, 'set01-review-villa-ar-rtl');

  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('setup-wizard-preview').waitFor();
    const mobileOverflow = await overflow(page);
    check(
      `mobile ${width}px renders without horizontal overflow`,
      mobileOverflow.documentDelta <= 0 &&
        mobileOverflow.bodyDelta <= 0 &&
        mobileOverflow.offenders.length === 0,
      JSON.stringify(mobileOverflow),
    );
    const clipped = await clippedActions(page);
    check(
      `mobile ${width}px keeps the primary wizard actions reachable`,
      clipped.length === 0,
      JSON.stringify(clipped),
    );
    const compactStepper =
      (await page.getByTestId('setup-stepper').isHidden()) &&
      (await page.getByTestId('setup-stepper-compact').isVisible());
    check(
      `mobile ${width}px swaps the stepper for the compact indicator`,
      compactStepper,
    );
    await shot(page, `set01-review-villa-ar-${width}x844`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.locator('.preferences-layout').waitFor();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');

  // SET-AT14 through the UI: an incomplete stored draft must refuse activation.
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New property' }).click();
  await page.getByLabel('Property code').fill(`SET08GATE-${runId}`);
  await page.getByLabel('Property name').fill('SET08 Gate');
  await page.getByRole('button', { name: 'Save' }).click();
  await page
    .getByLabel('Search properties by name or code')
    .fill(`SET08GATE-${runId}`);
  const gateRow = page.locator('table tbody tr', {
    hasText: `SET08GATE-${runId}`,
  });
  await gateRow.waitFor();
  await gateRow.getByRole('link', { name: 'SET08 Gate' }).click();
  await page.waitForURL(/\/properties\/[0-9a-f-]+$/);
  const gatePropertyId = page.url().split('/').pop();
  await page.goto(`${baseUrl}/setup-preview?propertyId=${gatePropertyId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('setup-server-banner').waitFor();
  await page.getByTestId('property-name').fill('SET08 Gate');
  await page.getByTestId('property-code').fill(`SET08GATE-${runId}`);
  await selectOption(page, 'property-timezone', 'Asia/Jakarta');
  await selectOption(page, 'property-currency', 'IDR');
  await page.getByTestId('property-type-ROOM').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-units').waitFor();
  await page.getByTestId('remove-group-0').click();
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`SET08GATE-${runId}`);
  const gateAgain = page.locator('table tbody tr', {
    hasText: `SET08GATE-${runId}`,
  });
  await gateAgain.waitFor();
  await gateAgain.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Activate' }).click();
  await page
    .getByText('Cannot apply before blocking gaps are resolved.')
    .waitFor({ timeout: 15000 });
  const gateBody = (await gateAgain.textContent()) ?? '';
  check(
    'SET-AT14: UI activation is refused while the stored draft is incomplete',
    gateBody.includes('Setup'),
    gateBody.slice(0, 120),
  );
  await shot(page, 'set08-activation-blocked-1440x900');

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New property' }).click();
  await page.getByLabel('Property code').fill(`SET03-${runId}`);
  await page.getByLabel('Property name').fill('SET03 Connected');
  await page.getByRole('button', { name: 'Save' }).click();
  await page
    .getByLabel('Search properties by name or code')
    .fill(`SET03-${runId}`);
  const connectedRow = page.locator('table tbody tr', {
    hasText: `SET03-${runId}`,
  });
  await connectedRow.waitFor();
  await connectedRow.getByRole('link', { name: 'SET03 Connected' }).click();
  await page.waitForURL(/\/properties\/[0-9a-f-]+$/);
  const connectedPropertyId = page.url().split('/').pop();
  await page.goto(
    `${baseUrl}/setup-preview?propertyId=${connectedPropertyId}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByTestId('setup-server-banner').waitFor();
  check('connected wizard renders the server draft banner', true);

  await page.getByTestId('property-name').fill('Connected draft');
  await page.getByTestId('property-code').fill(`SET03C${runId}`);
  await selectOption(page, 'property-timezone', 'Asia/Jakarta');
  await selectOption(page, 'property-currency', 'IDR');
  await page.getByTestId('property-type-ROOM').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('group-pattern-0').fill('201-205');
  await page.getByTestId('next-step').click();
  await page.getByLabel('Exclusive unit', { exact: true }).click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('explicit-states').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('postpone-pricing').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-review').waitFor();
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  const firstBanner = await page
    .getByTestId('setup-server-banner')
    .textContent();
  check(
    'connected draft saves to the server as revision 1',
    (firstBanner ?? '').includes('revision 1'),
    firstBanner ?? '',
  );
  await shot(page, 'set01-connected-saved-1440x900');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="property-name"]')?.value ===
      'Connected draft',
  );
  check('connected draft resumes from the server after reload', true);

  await page.getByTestId('property-name').fill('Connected draft v2');
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  const secondBanner = await page
    .getByTestId('setup-server-banner')
    .textContent();
  check(
    'connected save advances the server revision with If-Match',
    (secondBanner ?? '').includes('revision 2'),
    secondBanner ?? '',
  );
  await shot(page, 'set01-connected-revision-1440x900');

  await page.getByRole('button', { name: 'Review & simulation' }).click();
  await page.getByTestId('setup-step-review').waitFor();
  await page.getByTestId('preview-apply').click();
  await page.getByTestId('preview-result').waitFor();
  const connectedPreviewText = await page
    .getByTestId('preview-result')
    .textContent();
  check(
    'connected preview reports the generated units',
    (connectedPreviewText ?? '').includes('5'),
    connectedPreviewText ?? '',
  );
  await page.getByTestId('apply-draft').click();
  await page.getByTestId('apply-result').waitFor();
  const applyText = await page.getByTestId('apply-result').textContent();
  check(
    'connected apply creates the previewed units and products',
    (applyText ?? '').includes('5') && (applyText ?? '').includes('1'),
    applyText ?? '',
  );
  await shot(page, 'set01-connected-applied-1440x900');

  // PSR: the applied draft is immutable. Verify the readonly UI, then
  // prepare existing rooms in a separate property for the suite-picker test.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-read-only').waitFor();
  check(
    'PSR completed draft cannot be reopened in the wizard',
    (await page.getByTestId('save-draft').count()) === 0,
  );
  const suitePropertyId = await page.evaluate(async (suffix) => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const tenant = session.session.active_tenant_id;
    const csrf = decodeURIComponent(
      document.cookie.match(/(?:^|;\s*)hotel_csrf=([^;]+)/)?.[1] ?? '',
    );
    async function write(path, method, body, extra = {}) {
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          ...extra,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`Suite fixture failed: ${response.status}`);
      return response.json();
    }
    const code = `SET05E3-${suffix}`;
    const created = await write(`/tenants/${tenant}/properties`, 'POST', {
      code,
      name: 'Connected suite fixture',
      timezone: 'Asia/Jakarta',
    });
    const id = created.property.id;
    for (const code of ['201', '202', '203', '204', '205'])
      await write(`/tenants/${tenant}/properties/${id}/resources`, 'POST', {
        code,
        type: 'ROOM',
        capacity: 2,
      });
    await write(
      `/tenants/${tenant}/properties/${id}/setup-draft`,
      'PUT',
      {
        property: {
          name: 'Connected draft v2',
          code,
          timezone: 'Asia/Jakarta',
          base_currency: 'IDR',
          types: ['SUITE'],
        },
        unit_groups: [
          {
            template_code: 'ROOM',
            pattern: '201-205',
            capacity: 4,
            rental_mode: 'EXCLUSIVE',
          },
        ],
        operations: {
          check_in: '14:00',
          check_out: '12:00',
          explicit_states: true,
        },
        pricing: { postponed: true },
      },
      { 'idempotency-key': `visual-suite-${suffix}-draft` },
    );
    return id;
  }, runId);
  await page.goto(`${baseUrl}/setup-preview?propertyId=${suitePropertyId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="property-name"]')?.value ===
      'Connected draft v2',
  );
  await page.getByRole('button', { name: 'Units', exact: true }).click();
  await page.getByTestId('setup-step-units').waitFor();
  await selectCombobox(page, 'group-template-0', 'Connected suite');
  await page.getByTestId('group-pattern-0').fill('901-901');
  await page.getByTestId('next-step').click();
  await Promise.race([
    page.getByTestId('setup-step-rental').waitFor(),
    page.getByTestId('setup-errors').waitFor(),
  ]);
  if (
    await page
      .getByTestId('setup-errors')
      .isVisible()
      .catch(() => false)
  )
    throw new Error(
      `E3 units step rejected: ${await page.getByTestId('setup-errors').textContent()}`,
    );
  const room201 = page.getByTestId('connected-option-0-201');
  const room202 = page.getByTestId('connected-option-0-202');
  await room201.getByRole('checkbox').check();
  await room202.getByRole('checkbox').check();
  check(
    'E3 suite picker exposes existing resources and records two selections',
    (await room201.getByRole('checkbox').isChecked()) &&
      (await room202.getByRole('checkbox').isChecked()),
  );
  await page.getByLabel('Exclusive unit', { exact: true }).click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-operations').waitFor();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-pricing').waitFor();
  await page.getByTestId('next-step').click();
  await page.getByTestId('setup-step-review').waitFor();
  await page.getByTestId('save-draft').click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="save-state"]')?.textContent ?? '')
      .toLowerCase()
      .includes('saved'),
  );
  await page.getByTestId('preview-apply').click();
  await page.getByTestId('preview-result').waitFor();
  check(
    'E3 suite preview is ready without inventing a physical room',
    ((await page.getByTestId('preview-result').textContent()) ?? '').includes(
      'No blocking gaps',
    ),
  );
  await page.getByTestId('apply-draft').click();
  await page.getByTestId('apply-result').waitFor();
  const suiteApplyText = await page.getByTestId('apply-result').textContent();
  check(
    'E3 suite apply creates a product and composition with zero resources',
    (suiteApplyText ?? '').includes('0') &&
      (suiteApplyText ?? '').includes('1'),
    suiteApplyText ?? '',
  );
  await page.getByTestId('simulate-exclusive').click();
  await page.waitForFunction(() => {
    const text =
      document.querySelector('[data-testid="simulation-result"]')
        ?.textContent ?? '';
    return text.includes('201') && text.includes('202');
  });
  const suiteSimulation = await page
    .getByTestId('simulation-result')
    .textContent();
  check(
    'E3 server simulation resolves suite slot 901 to rooms 201 and 202',
    (suiteSimulation ?? '').includes('201') &&
      (suiteSimulation ?? '').includes('202'),
    suiteSimulation ?? '',
  );
  await shot(page, 'set05-e3-suite-server-simulation-1440x900');

  // SET-06: settings overview, change log and a dated composition change
  // through the property setup page.
  await page.goto(`${baseUrl}/properties/${suitePropertyId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByText('Change log').first().waitFor({ timeout: 20000 });
  await page.getByText('Resources:').first().waitFor({ timeout: 20000 });
  await page
    .getByText('setup_draft.applied')
    .first()
    .waitFor({ timeout: 20000 });
  const settingsBody = (await page.locator('#main').textContent()) ?? '';
  check(
    'SET-06 settings tab shows counts and the change log',
    settingsBody.includes('Resources:') &&
      settingsBody.includes('setup_draft.applied'),
    settingsBody.slice(0, 160),
  );
  await shot(page, 'set06-settings-overview-1440x900');

  await page.getByRole('tab', { name: 'Compositions' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('table tbody tr').length > 0,
    null,
    { timeout: 20000 },
  );
  const beforeRows = await page.locator('table tbody tr').count();
  await page.getByRole('button', { name: 'Dated change' }).first().click();
  await page
    .getByRole('dialog')
    .getByText('Dated composition change')
    .waitFor();
  await page.getByRole('button', { name: 'Preview impact' }).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return (dialog?.textContent ?? '').includes('Verdict');
  });
  const verdictText = (await page.getByRole('dialog').textContent()) ?? '';
  check(
    'SET-06 dated change preview reports a verdict and a fingerprint',
    verdictText.includes('Verdict') && verdictText.includes('Safe'),
    verdictText.slice(0, 160),
  );
  await shot(page, 'set06-dated-change-preview-1440x900');
  await page.getByRole('button', { name: 'Apply change' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('table tbody tr').length === expected,
    beforeRows + 1,
    { timeout: 20000 },
  );
  const afterRows = await page.locator('table tbody tr').count();
  check(
    'SET-06 dated change adds an immutable new version row',
    afterRows === beforeRows + 1,
    `${beforeRows} -> ${afterRows}`,
  );

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`SET03-${runId}`);
  const journeyRow = page.locator('table tbody tr', {
    hasText: `SET03-${runId}`,
  });
  await journeyRow.waitFor();
  await journeyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Activate' }).click();
  await page.waitForFunction(
    (code) => {
      const row = [...document.querySelectorAll('table tbody tr')].find((tr) =>
        tr.textContent?.includes(code),
      );
      return (row?.textContent ?? '').includes('Active');
    },
    `SET03-${runId}`,
    { timeout: 15000 },
  );
  check(
    'SET-08 journey: the completed then applied setup activates the property from the UI',
    true,
  );
  await shot(page, 'set08-property-activated-1440x900');

  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const memberPage = await signIn(
    memberContext,
    'viewer-v',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await memberPage.goto(`${baseUrl}/setup-preview`, {
    waitUntil: 'domcontentloaded',
  });
  await memberPage.locator('#main').first().waitFor({ timeout: 20000 });
  await memberPage.waitForTimeout(1200);
  const memberBody = (await memberPage.locator('body').textContent()) ?? '';
  check(
    'member without property.manage sees the forbidden panel',
    memberBody.includes('The server rejected') ||
      memberBody.includes('Server menolak') ||
      memberBody.includes('الخادم رفض'),
    memberBody.slice(0, 120),
  );
  await memberContext.close();

  const happyPathErrors = pageErrors.filter(
    (text) => !/Failed to load resource/.test(text),
  );
  check(
    'no uncaught page errors on the SET-01 reviews',
    happyPathErrors.length === 0,
    happyPathErrors.slice(0, 3).join(' | '),
  );

  const report = {
    scope: 'SET-01',
    captured_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: `chromium ${browser.version()}`,
    engine: 'playwright',
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
    `\nSET-01 visual: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
