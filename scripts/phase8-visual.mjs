import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const scope = 'P08-07';
const outDir = `.local/verification/${scope}`;
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
function bodyText(page) {
  return page
    .textContent('body')
    .then((text) => (text ?? '').replaceAll('\u00a0', ' '));
}
async function textOf(locator) {
  return ((await locator.textContent()) ?? '').replaceAll('\u00a0', ' ');
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
  /^\/api\/v1\/tenants\/[^/]+\/properties$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/resources$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/products\/[^/]+\/candidates$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rate-plans$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rate-plans\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/rates\/batch$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/quotes$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/drafts$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-in$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-out$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/charges$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/folios$/,
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
async function withOwner(task) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
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
      if (box.right > viewport + 1 || box.left < -1)
        offenders.push(element.tagName.toLowerCase());
    }
    return {
      documentDelta: documentElement.scrollWidth - documentElement.clientWidth,
      bodyDelta: document.body.scrollWidth - document.body.clientWidth,
      offenders: offenders.slice(0, 8),
    };
  });
}

const runId = String(Date.now()).slice(-6);
const today = shift(0);
const tomorrow = shift(1);
const dbEvidence = {};
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

function rowByText(text) {
  return page.locator('tbody tr').filter({ hasText: text });
}

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
  check('active tenant session', Boolean(tenantId), `tenant=${tenantId}`);

  const base = `/api/v1/tenants/${tenantId}/properties`;
  const property = await api(page, 'POST', base, {
    code: `P8V-${runId}`,
    name: `Phase 8 visual ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  check(
    'visual property created',
    property.status === 201,
    `status=${property.status}`,
  );
  const propertyId = property.body.property.id;

  const resource = await api(page, 'POST', `${base}/${propertyId}/resources`, {
    code: `P8V-R1-${runId}`,
    type: 'ROOM',
    capacity: 2,
  });
  const room = resource.body.resource;
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P8V-P-${runId}`,
    name: 'Visual finance room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  const productId = product.body.product.id;
  await api(
    page,
    'POST',
    `${base}/${propertyId}/products/${productId}/candidates`,
    { resource_id: room.id },
  );
  await api(page, 'PATCH', `${base}/${propertyId}/products/${productId}`, {
    version: product.body.product.version,
    status: 'ACTIVE',
  });
  const plan = await api(page, 'POST', `${base}/${propertyId}/rate-plans`, {
    code: `P8V-RATE-${runId}`,
    name: 'Visual finance rate',
    product_id: productId,
    currency: 'IDR',
  });
  const planId = plan.body.rate_plan.id;
  await api(page, 'PATCH', `${base}/${propertyId}/rate-plans/${planId}`, {
    version: plan.body.rate_plan.version,
    status: 'ACTIVE',
  });
  const cells = [];
  for (let offset = 0; offset <= 4; offset += 1)
    cells.push({
      rate_plan_id: planId,
      date: shift(offset),
      occupancy: 2,
      money: { amount: '285000', currency: 'IDR' },
    });
  const rates = await api(page, 'POST', `${base}/${propertyId}/rates/batch`, {
    cells,
  });
  const guest = await api(page, 'POST', `/api/v1/tenants/${tenantId}/guests`, {
    full_name: `P8V Guest ${runId}`,
    email: `p8v-${runId}@example.com`,
  });
  const guestId = guest.body.guest.id;
  const inventoryVersion = async () =>
    (
      await api(
        page,
        'GET',
        `${base}/${propertyId}/rates?from=${today}&to=${shift(4)}`,
      )
    ).body.inventory_version;
  const quote = await api(page, 'POST', `${base}/${propertyId}/quotes`, {
    product_id: productId,
    rate_plan_id: planId,
    period: { arrival: today, departure: tomorrow },
    occupancy: { adults: 2, child_ages: [] },
    quantity: 1,
  });
  const draft = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/drafts`,
    {
      source: 'DIRECT',
      items: [
        {
          product_id: productId,
          period: { arrival: today, departure: tomorrow },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
      guests: [{ guest_id: guestId, role: 'LEAD' }],
    },
  );
  if (draft.status !== 201)
    throw new Error(
      `draft failed: ${draft.status} ${JSON.stringify(draft.body)}`,
    );
  const reservationId = draft.body.reservation.id;
  const reservationDetail = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  const itemId = reservationDetail.body.items[0].id;
  const confirmed = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations`,
    {
      reservation_id: reservationId,
      inventory_version: await inventoryVersion(),
      items: [
        {
          item_id: itemId,
          price_snapshot_id: quote.body.quote.id,
        },
      ],
    },
  );
  check(
    'reservation, room and rate seeded via API',
    rates.status === 200 && confirmed.status === 200,
    `rates=${rates.status} confirm=${confirmed.status}`,
  );

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 15000 });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`P8V-${runId}`);
  const propertyRow = rowByText(`P8V-${runId}`);
  await propertyRow.waitFor({ timeout: 15000 });
  await propertyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Finance' }).click();
  await page.waitForURL(/\/finance$/, { timeout: 15000 });
  await page.getByRole('tab', { name: 'Folios' }).waitFor({ timeout: 20000 });
  check('property actions menu opens the finance page', true, page.url());
  const tabs = await page.getByRole('tab').allTextContents();
  check(
    'finance exposes the folio, payment, invoice, cashier and clearance tabs',
    [
      'Folios',
      'Payments',
      'Invoices',
      'Cashier',
      'Clearance & settlements',
    ].every((label) => tabs.includes(label)),
    tabs.join(' | '),
  );
  const dayResponse = await api(
    page,
    'GET',
    `${base}/${propertyId}/finance/business-day`,
  );
  const businessDate = dayResponse.body.date;
  await page
    .getByText(`Business day: ${businessDate}`)
    .waitFor({ timeout: 15000 });
  check(
    'business day chip echoes the property business date',
    true,
    businessDate,
  );
  await shot(page, 'finance-folios-empty');

  await page.getByRole('button', { name: 'Open folio', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Reservation ID').fill(reservationId);
  await dialog.getByLabel('Payer').fill(`P8V Guest ${runId}`);
  await dialog.getByRole('button', { name: 'Open folio', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  check(
    'open folio dialog lists the reservation folio',
    (await bodyText(page)).includes(`P8V Guest ${runId}`),
  );
  await page.getByRole('button', { name: 'Open folio', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Payer').fill(`P8V Company ${runId}`);
  await dialog.getByLabel('Folio type').click();
  await page.getByRole('option', { name: 'Company' }).click();
  await dialog.getByRole('button', { name: 'Open folio', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  check(
    'second payer folio opens for routing',
    (await bodyText(page)).includes(`P8V Company ${runId}`),
  );
  const guestRow = rowByText(`P8V Guest ${runId}`);
  await guestRow.getByRole('button', { name: 'Select' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'finance-folios');

  await page.getByRole('button', { name: 'Post charge', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Net amount (IDR)').fill('150000');
  await dialog.getByLabel('Tax amount (IDR)').fill('16500');
  await dialog
    .getByRole('button', { name: 'Post charge', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const chargesText = await bodyText(page);
  check(
    'post charge posts the net and tax with six-decimal money',
    chargesText.includes('IDR 150,000.00') &&
      chargesText.includes('IDR 16,500.00') &&
      chargesText.includes('IDR 166,500.00'),
    'net 150000 tax 16500 total 166500',
  );

  const chargeRow = page
    .locator('tbody tr')
    .filter({ hasText: 'charge-' })
    .first();
  await chargeRow.getByRole('button', { name: 'Route charge' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Payer folio').click();
  await page.getByRole('option', { name: /P8V Company/ }).click();
  await dialog.getByLabel('Allocated amount (IDR)').fill('50000');
  await dialog
    .getByRole('button', { name: 'Route charge', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const routedText = await bodyText(page);
  check(
    'route charge moves part of the charge to the payer folio',
    routedText.includes('IDR 50,000.00') &&
      routedText.includes('IDR 116,500.00'),
    'routed_out 50000 balance 116500',
  );

  await page.getByRole('tab', { name: 'Payments' }).click();
  await page.waitForTimeout(800);
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Payment amount (IDR)').fill('100000');
  await dialog
    .getByRole('button', { name: 'Record payment', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const paymentRow = rowByText('IDR 100,000.00');
  check(
    'cash payment is recorded as succeeded',
    (await textOf(paymentRow)).includes('Succeeded'),
    await textOf(paymentRow),
  );

  await page
    .getByRole('button', { name: 'Collect deposit', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Deposit amount (IDR)').fill('200000');
  await dialog
    .getByRole('button', { name: 'Collect deposit', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const depositText = await bodyText(page);
  check(
    'deposit is held as a liability line',
    depositText.includes('IDR 200,000.00') && depositText.includes('Held'),
  );

  const paymentRowForRefund = rowByText('IDR 100,000.00');
  await paymentRowForRefund
    .getByRole('button', { name: 'Request refund' })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Refund amount (IDR)').fill('10000');
  await dialog.getByLabel('Reason').fill(`P8V refund ${runId}`);
  await dialog
    .getByRole('button', { name: 'Request refund', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const refundRow = rowByText('IDR 10,000.00');
  check(
    'refund request reserves the amount with an approval id',
    (await textOf(refundRow)).includes('Reserved'),
    await textOf(refundRow),
  );
  await refundRow.getByRole('button', { name: 'Resolve' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Resolve', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const resolvedRow = rowByText('IDR 10,000.00');
  check(
    'failed refund resolution releases the reservation',
    (await textOf(resolvedRow)).includes('Failed'),
    await textOf(resolvedRow),
  );
  await shot(page, 'finance-payments');

  await page.getByRole('tab', { name: 'Invoices' }).click();
  await page.waitForTimeout(800);
  await page
    .getByRole('button', { name: 'Issue invoice', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Series').fill('PRD');
  await dialog.getByLabel('Invoice type').click();
  await page.getByRole('option', { name: 'Production' }).click();
  await dialog.getByLabel('Net amount (IDR)').fill('1000');
  await dialog
    .getByRole('button', { name: 'Issue invoice', exact: true })
    .click();
  await dialog.getByText('EX03_NOT_APPROVED').waitFor({ timeout: 10000 });
  check(
    'production invoice without EX-03 shows 422 EX03_NOT_APPROVED',
    (await dialog.textContent()).includes('422 EX03_NOT_APPROVED'),
    (await dialog.textContent()).slice(0, 200),
  );
  await shot(page, 'finance-invoice-ex03');
  await dialog.getByLabel('Series').fill('INV');
  await dialog.getByLabel('Invoice type').click();
  await page.getByRole('option', { name: 'Synthetic' }).click();
  await dialog.getByLabel('Net amount (IDR)').fill('100000');
  await dialog.getByLabel('Tax amount (IDR)').fill('11000');
  await dialog
    .getByRole('button', { name: 'Issue invoice', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const invoiceRow = rowByText('INV 1');
  check(
    'synthetic invoice gets series number and total',
    (await textOf(invoiceRow)).includes('IDR 111,000.00'),
    await textOf(invoiceRow),
  );
  await invoiceRow.getByRole('button', { name: 'Issue credit note' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Credit note amount (IDR)').fill('11000');
  await dialog.getByLabel('Reason').fill('P8V tax correction');
  await dialog
    .getByRole('button', { name: 'Issue credit note', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const creditText = await bodyText(page);
  check(
    'credit note is linked to the invoice',
    creditText.includes('CN 1') && creditText.includes('IDR 11,000.00'),
  );
  await shot(page, 'finance-invoices');

  await page.getByRole('tab', { name: 'Cashier' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Open session', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Opening float (IDR)').fill('50000');
  await dialog
    .getByRole('button', { name: 'Open session', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  let cashierRow = rowByText('IDR 50,000.00');
  check(
    'cashier session opens with the opening float',
    (await textOf(cashierRow)).includes('Open'),
    await textOf(cashierRow),
  );
  await cashierRow.getByRole('button', { name: 'Count cash' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Counted (IDR)').fill('49000');
  await dialog.getByRole('button', { name: 'Count cash', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  cashierRow = rowByText('IDR 50,000.00');
  const countedText = await textOf(cashierRow);
  check(
    'cashier count shows expected, counted and a negative variance',
    countedText.includes('IDR 50,000.00') &&
      countedText.includes('IDR 49,000.00') &&
      countedText.includes('-IDR 1,000.00') &&
      countedText.includes('Reconciled'),
    countedText,
  );
  await shot(page, 'finance-cashier');
  await cashierRow.getByRole('button', { name: 'Close session' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog
    .getByRole('button', { name: 'Close session', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  cashierRow = rowByText('IDR 50,000.00');
  const closedText = await textOf(cashierRow);
  check(
    'closing preserves the variance and the session is closed',
    closedText.includes('Closed') && closedText.includes('-IDR 1,000.00'),
    closedText,
  );

  dbEvidence.finance = await withOwner(async (client) => {
    const charges = await client.query(
      `select count(*)::int as count,
              coalesce(sum("net_amount" + "tax_amount"), 0)::text as total
         from "folio_charge" where "property_id" = $1`,
      [propertyId],
    );
    const invoices = await client.query(
      `select "series", "number", "kind", "total_amount"::text as "total_amount"
         from "folio_invoice" where "property_id" = $1 order by "created_at"`,
      [propertyId],
    );
    const sessions = await client.query(
      `select "state", "expected_amount"::text, "counted_amount"::text,
              "variance"::text
         from "cashier_session" where "property_id" = $1`,
      [propertyId],
    );
    return {
      charges: charges.rows[0],
      invoices: invoices.rows,
      cashier_sessions: sessions.rows,
    };
  });
  const financeEvidence = dbEvidence.finance;
  check(
    'database evidence matches the UI flow',
    financeEvidence.charges.count === 1 &&
      Number(financeEvidence.charges.total) === 166500 &&
      financeEvidence.invoices.length === 1 &&
      financeEvidence.cashier_sessions.length === 1 &&
      Number(financeEvidence.cashier_sessions[0]?.variance) === -1000,
    JSON.stringify(financeEvidence),
  );

  // ---- clearance / settlements flow through the finance UI ----
  let stayDetail = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  let stayItem = stayDetail.body.items[0];
  const checkedIn = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/${reservationId}/items/${stayItem.id}/check-in`,
    { version: stayItem.version, resource_id: room.id },
  );
  stayDetail = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  stayItem = stayDetail.body.items.find((entry) => entry.id === stayItem.id);
  const checkedOut = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/${reservationId}/items/${stayItem.id}/check-out`,
    { version: stayItem.version },
  );
  check(
    'visual reservation departs operationally with financial clearance PENDING',
    checkedIn.status === 200 &&
      checkedOut.status === 200 &&
      checkedOut.body.financial_clearance_state === 'PENDING',
    `check-in=${checkedIn.status} check-out=${checkedOut.status} clearance=${checkedOut.body.financial_clearance_state}`,
  );
  const folioRows = await api(
    page,
    'GET',
    `${base}/${propertyId}/folios?reservation_id=${reservationId}`,
  );
  const guestFolio = folioRows.body.folios.find((row) => row.kind === 'GUEST');
  const extraCharge = await api(page, 'POST', `${base}/${propertyId}/charges`, {
    folio_id: guestFolio.id,
    business_date: businessDate,
    money: { amount: '250000', currency: 'IDR' },
    account_code: 'REVENUE_OTHER',
    source_ref: `p8v-clearance-${runId}`,
  });
  check(
    'departed reservation carries a ledger balance for clearance',
    extraCharge.status === 200,
    `charge=${extraCharge.status}`,
  );

  await page.getByRole('tab', { name: 'Clearance & settlements' }).click();
  await page.getByLabel('Reservation ID for clearance').fill(reservationId);
  await page.getByRole('button', { name: 'Load clearance' }).click();
  await page
    .getByText('Outstanding balance remains', { exact: false })
    .first()
    .waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  const pendingText = await bodyText(page);
  check(
    'clearance shows PENDING after departure with the outstanding balance',
    pendingText.includes('Pending') &&
      pendingText.includes('Departed') &&
      pendingText.includes('IDR 255,500.00'),
    'departed=PENDING balance=255500 (credit note 11000 already posted)',
  );
  await shot(page, 'finance-clearance-pending');

  await page.getByRole('button', { name: 'Settle clearance' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Settle clearance' }).click();
  await dialog.getByText('CLEARANCE_OUTSTANDING').waitFor({ timeout: 15000 });
  check(
    'SETTLED with an outstanding balance fails closed with 422 CLEARANCE_OUTSTANDING',
    (await dialog.textContent()).includes('422 CLEARANCE_OUTSTANDING'),
    (await dialog.textContent()).slice(0, 200),
  );
  await shot(page, 'finance-clearance-outstanding');

  await dialog.getByLabel('Settlement basis').click();
  await page.getByRole('option', { name: 'Transfer to payer' }).click();
  await dialog.getByLabel('Authorized company payer').click();
  await page
    .getByRole('option', { name: new RegExp(`P8V Company ${runId}`) })
    .click();
  await dialog
    .getByLabel('Collection plan reference')
    .fill(`P8V-PLAN-${runId}`);
  await dialog.getByRole('button', { name: 'Settle clearance' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1200);
  const clearedText = await bodyText(page);
  check(
    'TRANSFER_TO_PAYER to a COMPANY payer clears with basis and plan reference',
    clearedText.includes('Cleared') &&
      clearedText.includes('Transfer to payer') &&
      clearedText.includes(`P8V-PLAN-${runId}`),
    `plan=P8V-PLAN-${runId}`,
  );
  await shot(page, 'finance-clearance-cleared');

  await page.getByRole('tab', { name: 'Payments' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Record payment' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Folio', { exact: true }).click();
  await page
    .getByRole('option', { name: new RegExp(`P8V Company ${runId}`) })
    .click();
  await dialog.getByLabel('Method').click();
  await page.getByRole('option', { name: 'OTA settlement' }).click();
  await dialog.getByLabel('Payment amount (IDR)').fill('1000000');
  await dialog.getByLabel('Gross amount (IDR)').fill('1150000');
  await dialog.getByLabel('Commission amount (IDR)').fill('150000');
  await dialog.getByLabel('External reference').fill(`P8V-OTA-${runId}`);
  await dialog.getByLabel('Evidence reference').fill(randomUUID());
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);

  await page.getByRole('tab', { name: 'Clearance & settlements' }).click();
  await page.waitForTimeout(1200);
  const externalTable = page.locator(
    'table[aria-label="External settlements"]',
  );
  await externalTable.waitFor({ timeout: 15000 });
  const externalText = await textOf(externalTable);
  check(
    'external settlements list shows net, gross and commission without conversion',
    externalText.includes('IDR 1,000,000.00') &&
      externalText.includes('IDR 1,150,000.00') &&
      externalText.includes('IDR 150,000.00') &&
      externalText.includes('Succeeded'),
    externalText.slice(0, 300),
  );
  await shot(page, 'finance-external-settlements');

  dbEvidence.clearance = await withOwner(async (client) => {
    const reservationRow = await client.query(
      `select "financial_clearance_state", "financial_clearance_basis",
              "financial_clearance_reference", "financial_clearance_payer_folio_id"
         from "reservation" where "id" = $1`,
      [reservationId],
    );
    const settlements = await client.query(
      `select "amount"::text as "amount", "gross_amount"::text as "gross_amount",
              "commission_amount"::text as "commission_amount", "state"
         from "folio_payment"
        where "property_id" = $1 and "method" = 'OTA_SETTLEMENT'`,
      [propertyId],
    );
    return {
      reservation: reservationRow.rows[0],
      settlements: settlements.rows,
    };
  });
  check(
    'database evidence confirms CLEARED by transfer and the OTA split',
    dbEvidence.clearance.reservation.financial_clearance_state === 'CLEARED' &&
      dbEvidence.clearance.reservation.financial_clearance_basis ===
        'TRANSFER_TO_PAYER' &&
      dbEvidence.clearance.reservation.financial_clearance_reference ===
        `P8V-PLAN-${runId}` &&
      dbEvidence.clearance.settlements.length === 1 &&
      Number(dbEvidence.clearance.settlements[0]?.gross_amount) === 1150000 &&
      Number(dbEvidence.clearance.settlements[0]?.commission_amount) === 150000,
    JSON.stringify(dbEvidence.clearance).slice(0, 300),
  );

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /العربية/ }).click();
  await page.waitForTimeout(800);
  await page.goto(`${baseUrl}/properties/${propertyId}/finance`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('tab', { name: 'الحسابات' }).waitFor({ timeout: 20000 });
  const dir = await page.evaluate(() => document.documentElement.dir);
  check('finance renders RTL in Arabic', dir === 'rtl', `dir=${dir}`);
  await shot(page, 'finance-arabic-rtl');

  await page.getByRole('tab', { name: 'الذمة والتسويات' }).click();
  await page.getByLabel('معرّف الحجز للتسوية').fill(reservationId);
  await page.getByRole('button', { name: 'تحميل الذمة' }).click();
  await page.getByText('محسومة').first().waitFor({ timeout: 20000 });
  const rtlClearanceText = await bodyText(page);
  check(
    'clearance tab renders RTL with the cleared transfer',
    dir === 'rtl' && rtlClearanceText.includes('تحويل إلى الدافع'),
    `dir=${dir}`,
  );
  await shot(page, 'finance-clearance-arabic-rtl');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: 'الحسابات' }).click();
  await page.waitForTimeout(600);
  const mobileOverflow = await overflow(page);
  check(
    'no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.offenders.length === 0,
    JSON.stringify(mobileOverflow),
  );
  await shot(page, 'finance-mobile');
  await page.getByRole('tab', { name: 'الذمة والتسويات' }).click();
  await page.waitForTimeout(600);
  const clearanceMobileOverflow = await overflow(page);
  check(
    'clearance tab has no horizontal overflow at 390px',
    clearanceMobileOverflow.documentDelta <= 1 &&
      clearanceMobileOverflow.offenders.length === 0,
    JSON.stringify(clearanceMobileOverflow),
  );
  await shot(page, 'finance-clearance-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  check(
    'no page errors',
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '),
  );
  const expected422 =
    /Failed to load resource: the server responded with a status of 422/;
  const unexpectedConsole = consoleErrors.filter(
    (text) => !expected422.test(text),
  );
  check(
    'no unexpected console errors beyond the intentional EX-03 422',
    unexpectedConsole.length === 0,
    unexpectedConsole.slice(0, 3).join(' | '),
  );
} catch (error) {
  check('visual phase 8 run completed', false, String(error).slice(0, 500));
} finally {
  const report = {
    scope,
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    browser: `chromium ${browser.version()}`,
    engine: 'playwright',
    checks,
    failures,
    screenshots,
    db_evidence: dbEvidence,
    page_errors: pageErrors,
    console_errors: consoleErrors,
  };
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(
    `${outDir}/db-evidence.json`,
    JSON.stringify(dbEvidence, null, 2),
  );
  console.log(
    `\n${scope}: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  await context.close();
  await browser.close();
  if (failures.length > 0) process.exitCode = 1;
}
