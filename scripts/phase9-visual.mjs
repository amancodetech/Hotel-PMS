import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const scope = 'P09-03';
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
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/tasks$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/assign$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/start$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/complete$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/tasks\/[^/]+\/inspect$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/operations-policy$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/work-orders$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/assign$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/transitions$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/close$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/work-orders\/[^/]+\/reopen$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/dnd-logs$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/dnd-logs\/[^/]+\/follow-up$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/shift-handovers$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/notifications\/[^/]+\/read$/,
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
    ['POST', 'PUT', 'PATCH'].includes(method) &&
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
  const date = new Date(`${todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function todayIso() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
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
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      let node = element.parentElement;
      let scrollable = false;
      while (node && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') scrollable = true;
        node = node.parentElement;
      }
      if (scrollable) continue;
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
async function setLanguage(page, optionName) {
  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: optionName }).click();
  await page.waitForTimeout(800);
}

const runId = String(Date.now()).slice(-6);
const today = todayIso();
const dbEvidence = {};
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const page = await context.newPage();
const inspectorContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});
const inspectorPage = await inspectorContext.newPage();
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
  await signIn(
    inspectorContext,
    'owner-a',
    process.env.KEYCLOAK_TEST_USER_PASSWORD,
  );
  await setLanguage(page, /English/);
  await setLanguage(inspectorPage, /English/);
  const session = await api(page, 'GET', '/api/v1/auth/session');
  const tenantId = session.body.session?.active_tenant_id;
  check('active tenant session', Boolean(tenantId), `tenant=${tenantId}`);

  const base = `/api/v1/tenants/${tenantId}/properties`;
  const property = await api(page, 'POST', base, {
    code: `P9V-${runId}`,
    name: `Phase 9 visual ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  check(
    'visual property created',
    property.status === 201,
    `status=${property.status}`,
  );
  const propertyId = property.body.property.id;
  const rooms = {};
  for (const suffix of ['R1', 'R2', 'R3']) {
    const resource = await api(
      page,
      'POST',
      `${base}/${propertyId}/resources`,
      {
        code: `P9V-${suffix}-${runId}`,
        type: 'ROOM',
        capacity: 2,
      },
    );
    rooms[suffix] = resource.body.resource;
  }
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P9V-P-${runId}`,
    name: 'Visual operations room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  const productId = product.body.product.id;
  for (const room of Object.values(rooms))
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
    code: `P9V-RATE-${runId}`,
    name: 'Visual operations rate',
    product_id: productId,
    currency: 'IDR',
  });
  const planId = plan.body.rate_plan.id;
  await api(page, 'PATCH', `${base}/${propertyId}/rate-plans/${planId}`, {
    version: plan.body.rate_plan.version,
    status: 'ACTIVE',
  });
  const cells = [];
  for (let offset = 0; offset <= 6; offset += 1)
    cells.push({
      rate_plan_id: planId,
      date: shift(offset),
      occupancy: 2,
      money: { amount: '310000', currency: 'IDR' },
    });
  await api(page, 'POST', `${base}/${propertyId}/rates/batch`, { cells });
  const quote = await api(page, 'POST', `${base}/${propertyId}/quotes`, {
    product_id: productId,
    rate_plan_id: planId,
    period: { arrival: today, departure: shift(2) },
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
          period: { arrival: today, departure: shift(2) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
    },
  );
  const reservationId = draft.body.reservation.id;
  const detail = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  const itemId = detail.body.items[0].id;
  const inventory = await api(
    page,
    'GET',
    `${base}/${propertyId}/rates?from=${today}&to=${shift(6)}`,
  );
  await api(page, 'POST', `${base}/${propertyId}/reservations`, {
    reservation_id: reservationId,
    inventory_version: inventory.body.inventory_version,
    items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
  });
  const afterConfirm = await api(
    page,
    'GET',
    `${base}/${propertyId}/reservations/${reservationId}`,
  );
  const itemVersion = afterConfirm.body.items[0].version;
  const checkIn = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/${reservationId}/items/${itemId}/check-in`,
    { version: itemVersion, resource_id: rooms.R1.id },
  );
  check(
    'stay checked in for the turnover flow',
    checkIn.status === 200,
    `status=${checkIn.status} ${JSON.stringify(checkIn.body)}`,
  );
  const checkout = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/${reservationId}/items/${itemId}/check-out`,
    { version: checkIn.body.item_version },
  );
  check(
    'checkout materializes the prep task before the UI opens',
    checkout.status === 200,
    `status=${checkout.status}`,
  );
  const identityUsers = JSON.parse(
    (await import('node:fs')).readFileSync(
      '.local/identity-users.json',
      'utf8',
    ),
  );
  dbEvidence.memberships = await withOwner(async (client) => {
    const result = await client.query(
      `select m."id", u."identity_subject" from "membership" m
        join "app_user" u on u."id" = m."user_id"
       where m."tenant_id" = $1`,
      [tenantId],
    );
    return result.rows;
  });
  const ownerMembershipId = dbEvidence.memberships.find(
    (row) => row.identity_subject === identityUsers.users['owner-a'].id,
  )?.id;
  check('owner membership resolved for assignment', Boolean(ownerMembershipId));

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 15000 });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`P9V-${runId}`);
  const propertyRow = rowByText(`P9V-${runId}`);
  await propertyRow.waitFor({ timeout: 15000 });
  await propertyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Operations' }).click();
  await page.waitForURL(/\/operations$/, { timeout: 15000 });
  await page.getByRole('tab', { name: 'Housekeeping' }).waitFor({
    timeout: 20000,
  });
  check('PropertiesPage opens the operations page', true, page.url());
  const tabs = await page.getByRole('tab').allTextContents();
  check(
    'operations exposes housekeeping, maintenance, DND, handover and notification tabs',
    [
      'Housekeeping',
      'Maintenance',
      'DND log',
      'Shift handover',
      'Notifications',
    ].every((label) => tabs.includes(label)),
    tabs.join(' | '),
  );
  await page
    .locator('tbody tr', { hasText: `P9V-R1-${runId}` })
    .waitFor({ timeout: 15000 });
  check(
    'checkout task appears with the room code and pending bucket',
    (await bodyText(page)).includes('Pending: 1'),
  );
  await shot(page, 'ops-tasks-pending');

  await page.getByRole('button', { name: 'Operations policy' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.locator('input[type="checkbox"]').check();
  await dialog.getByLabel('Long-stay cleaning interval (days)').fill('3');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  check(
    'inspection policy can be enabled from the UI',
    (await bodyText(page)).includes('Inspection required before delivery'),
  );
  await shot(page, 'ops-policy-dialog');

  const taskRow = page.locator('tbody tr', { hasText: `P9V-R1-${runId}` });
  await taskRow.getByRole('button', { name: 'Assign' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Assignee').click();
  await page
    .getByRole('option', { name: ownerMembershipId.slice(0, 8) })
    .click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  check(
    'task assignment via UI moves it to the assigned bucket',
    (await bodyText(page)).includes('Assigned: 1'),
  );

  await inspectorPage.goto(`${baseUrl}/properties/${propertyId}/operations`, {
    waitUntil: 'domcontentloaded',
  });
  await inspectorPage
    .getByRole('tab', { name: 'Housekeeping' })
    .waitFor({ timeout: 20000 });
  const inspectorRow = inspectorPage
    .locator('tbody tr')
    .filter({ hasText: `P9V-R1-${runId}` });
  await inspectorRow.getByRole('button', { name: 'Start' }).click();
  await inspectorPage.waitForTimeout(1200);
  await inspectorRow.getByRole('button', { name: 'Report clean' }).click();
  await inspectorPage.waitForTimeout(1200);
  check('housekeeper start and clean reporting work in the UI', true);
  dbEvidence.taskCleaning = await withOwner(async (client) => {
    const result = await client.query(
      `select t."status", r."housekeeping_state"
         from "ops_task" t join "resource" r on r."id" = t."resource_id"
        where t."property_id" = $1 and r."code" = $2`,
      [propertyId, `P9V-R1-${runId}`],
    );
    return result.rows[0];
  });
  check(
    'report clean leaves the room CLEAN awaiting inspection',
    dbEvidence.taskCleaning.status === 'CLEAN' &&
      dbEvidence.taskCleaning.housekeeping_state === 'CLEAN',
    JSON.stringify(dbEvidence.taskCleaning),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Housekeeping' }).waitFor({
    timeout: 20000,
  });
  await page
    .locator('tbody tr', { hasText: `P9V-R1-${runId}` })
    .getByRole('button', { name: 'Inspect' })
    .click();
  await page.waitForTimeout(1200);
  check(
    'inspection via UI moves the task to ready',
    (await bodyText(page)).includes('Ready: 1'),
  );
  await shot(page, 'ops-tasks-ready');
  dbEvidence.taskInspected = await withOwner(async (client) => {
    const result = await client.query(
      `select t."status", t."inspected_at", r."housekeeping_state"
         from "ops_task" t join "resource" r on r."id" = t."resource_id"
        where t."property_id" = $1 and r."code" = $2`,
      [propertyId, `P9V-R1-${runId}`],
    );
    return result.rows[0];
  });
  check(
    'inspection persists INSPECTED on the task and the room',
    dbEvidence.taskInspected.status === 'INSPECTED' &&
      dbEvidence.taskInspected.housekeeping_state === 'INSPECTED',
    JSON.stringify(dbEvidence.taskInspected),
  );
  const taskApi = await api(
    page,
    'GET',
    `${base}/${propertyId}/tasks?resource_id=${rooms.R1.id}`,
  );
  const taskKeys = Object.keys(taskApi.body.tasks?.[0] ?? {});
  check(
    'task views never include guest identity or money fields',
    taskApi.status === 200 &&
      ['guest', 'guest_id', 'document', 'balance_due', 'money'].every(
        (key) => !taskKeys.includes(key),
      ),
    taskKeys.join(','),
  );

  await page.getByRole('tab', { name: 'Maintenance' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'New work order' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Room').click();
  await page.getByRole('option', { name: `P9V-R2-${runId}` }).click();
  await dialog.getByLabel('Inventory impact').click();
  await page.getByRole('option', { name: 'OOO' }).click();
  await dialog.getByLabel('Period start').fill(today);
  await dialog.getByLabel('Period end').fill(shift(2));
  await dialog.getByLabel('Description').fill(`Visual work order ${runId}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  check(
    'work order creation from the UI opens OOO on the room',
    (await bodyText(page)).includes(`P9V-R2-${runId}`),
  );
  dbEvidence.workOrderOoo = await withOwner(async (client) => {
    const result = await client.query(
      `select "maintenance_state" from "resource" where "code" = $1`,
      [`P9V-R2-${runId}`],
    );
    return result.rows[0];
  });
  check(
    'OOO impact reaches the resource state',
    dbEvidence.workOrderOoo.maintenance_state === 'OOO',
    JSON.stringify(dbEvidence.workOrderOoo),
  );
  const workRow = page.locator('tbody tr', { hasText: `P9V-R2-${runId}` });
  await workRow.getByRole('button', { name: 'Start' }).click();
  await page.waitForTimeout(1000);
  await workRow.getByRole('button', { name: 'Resolve' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Resolution note').fill('Seal replaced');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  const workRowAgain = page.locator('tbody tr', { hasText: `P9V-R2-${runId}` });
  await workRowAgain.getByRole('button', { name: 'Verify' }).click();
  await page.waitForTimeout(1000);
  await workRowAgain.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(1200);
  dbEvidence.workOrderClosed = await withOwner(async (client) => {
    const result = await client.query(
      `select w."status", r."maintenance_state"
         from "ops_work_order" w join "resource" r on r."id" = w."resource_id"
        where w."property_id" = $1 and r."code" = $2`,
      [propertyId, `P9V-R2-${runId}`],
    );
    return result.rows[0];
  });
  check(
    'verified and closed work order clears OOO',
    dbEvidence.workOrderClosed.status === 'CLOSED' &&
      dbEvidence.workOrderClosed.maintenance_state === 'NONE',
    JSON.stringify(dbEvidence.workOrderClosed),
  );
  await shot(page, 'ops-maintenance');

  await page.getByRole('button', { name: 'New work order' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Room').click();
  await page.getByRole('option', { name: `P9V-R3-${runId}` }).click();
  await dialog.getByLabel('Inventory impact').click();
  await page.getByRole('option', { name: 'OOO' }).click();
  await dialog.getByLabel('Period start').fill(today);
  await dialog.getByLabel('Period end').fill(shift(2));
  await dialog.locator('input[type="checkbox"]').check();
  await dialog.getByLabel('Description').fill(`Emergency leak ${runId}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  check(
    'emergency work order is created from the UI',
    (await bodyText(page)).includes('Emergency'),
  );
  dbEvidence.emergency = await withOwner(async (client) => {
    const result = await client.query(
      `select w."block_id", b."state" as "block_state"
         from "ops_work_order" w
         left join "inventory_block" b on b."id" = w."block_id"
        where w."property_id" = $1 and w."emergency" = true`,
      [propertyId],
    );
    return result.rows[0];
  });
  check(
    'emergency creates an active block without touching reservations',
    Boolean(dbEvidence.emergency.block_id) &&
      dbEvidence.emergency.block_state === 'ACTIVE',
    JSON.stringify(dbEvidence.emergency),
  );

  await page.getByRole('tab', { name: 'Notifications' }).click();
  await page.waitForTimeout(1000);
  check(
    'critical emergency notification appears in the internal inbox',
    (await bodyText(page)).includes('Emergency maintenance'),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const unread = page.getByRole('button', { name: 'Mark read' });
    if ((await unread.count()) === 0) break;
    await unread.first().click();
    await page.waitForTimeout(800);
  }
  check(
    'notification read receipts are recorded',
    (await bodyText(page)).includes('Read'),
  );
  await shot(page, 'ops-notifications');
  dbEvidence.notification = await withOwner(async (client) => {
    const result = await client.query(
      `select n."type", n."severity", count(r."membership_id")::int as "receipts"
         from "ops_notification" n
         left join "ops_notification_receipt" r on r."notification_id" = n."id"
        where n."property_id" = $1 and n."type" = 'WORK_ORDER_EMERGENCY'
        group by n."type", n."severity"`,
      [propertyId],
    );
    return result.rows[0];
  });
  check(
    'the emergency alert stays internal with a read receipt',
    dbEvidence.notification?.severity === 'CRITICAL' &&
      Number(dbEvidence.notification.receipts) >= 1,
    JSON.stringify(dbEvidence.notification),
  );

  await page.getByRole('tab', { name: 'DND' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Log DND' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Room').click();
  await page.getByRole('option', { name: `P9V-R2-${runId}` }).click();
  await dialog.getByLabel('Note').fill('Guest asked for later service');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Follow up' }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Note').fill('Called room; service accepted');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  dbEvidence.dnd = await withOwner(async (client) => {
    const result = await client.query(
      `select l."state", r."housekeeping_state"
         from "ops_dnd_log" l join "resource" r on r."id" = l."resource_id"
        where l."property_id" = $1 and r."code" = $2
        order by l."created_at" desc limit 1`,
      [propertyId, `P9V-R2-${runId}`],
    );
    return result.rows[0];
  });
  check(
    'DND follow-up never flips housekeeping state',
    dbEvidence.dnd.state === 'FOLLOWED_UP' &&
      dbEvidence.dnd.housekeeping_state === 'CLEAN',
    JSON.stringify(dbEvidence.dnd),
  );
  await shot(page, 'ops-dnd');

  await page.getByRole('tab', { name: 'Shift handover' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'New shift handover' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Hand over to').click();
  await page
    .getByRole('option', { name: ownerMembershipId.slice(0, 8) })
    .click();
  await dialog.getByLabel('Exceptions').fill(`Emergency leak ${runId}`);
  await dialog.getByLabel('Note').fill('Night shift');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(1000);
  check(
    'shift handover appears with recorded counts',
    (await bodyText(page)).includes(`Emergency leak ${runId}`),
  );
  await shot(page, 'ops-handover');
  dbEvidence.handover = await withOwner(async (client) => {
    const result = await client.query(
      `select "open_tasks", "open_work_orders", "active_dnd",
              "cashier_session_id"
         from "ops_shift_handover"
        where "property_id" = $1 order by "created_at" desc limit 1`,
      [propertyId],
    );
    return result.rows[0];
  });
  check(
    'handover snapshot keeps the cashier session reference separate',
    dbEvidence.handover && dbEvidence.handover.cashier_session_id === null,
    JSON.stringify(dbEvidence.handover),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .getByRole('tab', { name: 'Housekeeping' })
    .waitFor({ timeout: 20000 });
  const mobileOverflow = await overflow(page);
  check(
    'operations page has no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.bodyDelta <= 1,
    JSON.stringify(mobileOverflow),
  );
  await shot(page, 'ops-390');

  await setLanguage(page, /العربية/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/properties/${propertyId}/operations`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('tab', { name: 'التدبير' }).waitFor({ timeout: 20000 });
  check(
    'operations page renders in Arabic RTL',
    await page.evaluate(
      () => document.documentElement.getAttribute('dir') === 'rtl',
    ),
  );
  await shot(page, 'ops-ar-rtl');
  await setLanguage(page, /English/);
} catch (error) {
  check('visual run completed without throwing', false, String(error));
  console.error(error);
} finally {
  writeFileSync(
    `${outDir}/report.json`,
    `${JSON.stringify(
      {
        scope,
        generated_at: new Date().toISOString(),
        base_url: baseUrl,
        browser: 'chromium',
        engine: 'playwright',
        checks,
        failures,
        screenshots,
        page_errors: pageErrors,
        console_errors: consoleErrors,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    `${outDir}/db-evidence.json`,
    `${JSON.stringify(dbEvidence, null, 2)}\n`,
  );
  await context.close();
  await inspectorContext.close();
  await browser.close();
  const passed = checks.filter((row) => row.ok).length;
  console.log(
    `${passed}/${checks.length} checks passed; ${screenshots.length} screenshots`,
  );
  if (failures.length > 0) process.exitCode = 1;
}
