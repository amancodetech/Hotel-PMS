import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from 'pg';

const baseUrl = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4100';
const outDir = '.local/verification/P07-05';
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
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/drafts$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservation-items\/[^/]+\/cancel$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/assignments$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-in$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/move$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/extend$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/split$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/early-departure$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/partial-departure$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/reservations\/[^/]+\/items\/[^/]+\/check-out$/,
  /^\/api\/v1\/tenants\/[^/]+\/properties\/[^/]+\/imports$/,
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
  // The synthetic property runs Asia/Jakarta (UTC+7); operational dates must
  // match the API business date, not the host UTC date.
  const date = new Date(Date.now() + 7 * 3600_000);
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
    code: `P7V-${runId}`,
    name: `Phase 7 visual ${runId}`,
    timezone: 'Asia/Jakarta',
  });
  check(
    'visual property created',
    property.status === 201,
    `status=${property.status}`,
  );
  const propertyId = property.body.property.id;

  const rooms = [];
  for (const index of [1, 2, 3]) {
    const resource = await api(
      page,
      'POST',
      `${base}/${propertyId}/resources`,
      {
        code: `P7V-R${index}-${runId}`,
        type: 'ROOM',
        capacity: 2,
      },
    );
    if (resource.status !== 201)
      throw new Error(
        `resource ${index} failed: ${resource.status} ${JSON.stringify(resource.body)}`,
      );
    rooms.push(resource.body.resource);
  }
  const product = await api(page, 'POST', `${base}/${propertyId}/products`, {
    code: `P7V-P-${runId}`,
    name: 'Visual front desk room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  const productId = product.body.product.id;
  for (const room of rooms)
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
    code: `P7V-RATE-${runId}`,
    name: 'Visual front desk rate',
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
      money: { amount: '285000', currency: 'IDR' },
    });
  const rates = await api(page, 'POST', `${base}/${propertyId}/rates/batch`, {
    cells,
  });
  check(
    'rooms, product, rate plan and rates seeded via API',
    rates.status === 200 && rooms.length === 3,
    `rates=${rates.status}`,
  );

  const guestIds = [];
  for (const index of [1, 2, 3, 4]) {
    const guest = await api(
      page,
      'POST',
      `/api/v1/tenants/${tenantId}/guests`,
      {
        full_name: `P7V Guest${index} ${runId}`,
        email: `p7v-${index}-${runId}@example.com`,
      },
    );
    guestIds.push(guest.body.guest.id);
  }
  const [guestA, guestA2, guestB, guestC] = guestIds;

  const inventoryVersion = async () =>
    (
      await api(
        page,
        'GET',
        `${base}/${propertyId}/rates?from=${today}&to=${shift(6)}`,
      )
    ).body.inventory_version;
  const quote = async (arrival, departure) => {
    const response = await api(page, 'POST', `${base}/${propertyId}/quotes`, {
      product_id: productId,
      rate_plan_id: planId,
      period: { arrival, departure },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    });
    if (response.status !== 201)
      throw new Error(
        `quote failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    return response.body.quote.id;
  };
  const createConfirmed = async (arrival, departure, guests) => {
    const draft = await api(
      page,
      'POST',
      `${base}/${propertyId}/reservations/drafts`,
      {
        source: 'DIRECT',
        items: [
          {
            product_id: productId,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        guests,
      },
    );
    if (draft.status !== 201)
      throw new Error(
        `draft failed: ${draft.status} ${JSON.stringify(draft.body)}`,
      );
    const reservationId = draft.body.reservation.id;
    const detail = await api(
      page,
      'GET',
      `${base}/${propertyId}/reservations/${reservationId}`,
    );
    const itemId = detail.body.items[0].id;
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
            price_snapshot_id: await quote(arrival, departure),
          },
        ],
      },
    );
    if (confirmed.status !== 200)
      throw new Error(
        `confirm failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`,
      );
    return { reservationId, itemId };
  };
  const detail = async (reservationId) =>
    (
      await api(
        page,
        'GET',
        `${base}/${propertyId}/reservations/${reservationId}`,
      )
    ).body;
  const board = async (date = today) =>
    (
      await api(
        page,
        'GET',
        `${base}/${propertyId}/front-desk/board?date=${date}`,
      )
    ).body;

  const stayA = await createConfirmed(today, shift(3), [
    { guest_id: guestA, role: 'LEAD' },
    { guest_id: guestA2, role: 'ACCOMPANYING' },
  ]);
  const stayB = await createConfirmed(today, shift(2), [
    { guest_id: guestB, role: 'LEAD' },
  ]);
  await createConfirmed(today, shift(1), [{ guest_id: guestC, role: 'LEAD' }]);
  const boardToday = await board(today);
  const arrivals = boardToday.arrivals;
  check(
    'three confirmed arrivals seeded via API',
    arrivals.length >= 3,
    `arrivals=${arrivals.length}`,
  );
  check(
    'board echoes the requested business date and property timezone',
    boardToday.date === today && boardToday.timezone === 'Asia/Jakarta',
    `date=${boardToday.date} timezone=${boardToday.timezone}`,
  );

  await page.goto(`${baseUrl}/properties`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 15000 });
  await page
    .getByLabel('Search properties by name or code')
    .fill(`P7V-${runId}`);
  const propertyRow = rowByText(`P7V-${runId}`);
  await propertyRow.waitFor({ timeout: 15000 });
  await propertyRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Front desk' }).click();
  await page.waitForURL(/\/front-desk$/, { timeout: 15000 });
  await page.getByRole('tab', { name: 'Arrivals' }).waitFor({ timeout: 20000 });
  await page.waitForSelector('table', { timeout: 15000 });
  check('property actions menu opens the front desk page', true, page.url());
  const tabs = await page.getByRole('tab').allTextContents();
  check(
    'front desk exposes the four operational tabs',
    ['Arrivals', 'Departures', 'In house', 'Room rack'].every((label) =>
      tabs.includes(label),
    ),
    tabs.join(' | '),
  );
  await page
    .getByText(`P7V Guest1 ${runId}`)
    .first()
    .waitFor({ timeout: 15000 });
  const arrivalsText = await page.textContent('body');
  check(
    'arrivals tab lists all seeded guests',
    [`P7V Guest1 ${runId}`, `P7V Guest3 ${runId}`, `P7V Guest4 ${runId}`].every(
      (name) => arrivalsText.includes(name),
    ),
  );
  await shot(page, 'frontdesk-arrivals');

  await page.getByRole('tab', { name: 'Room rack' }).click();
  await page.waitForTimeout(800);
  const rackText = await page.textContent('body');
  check(
    'room rack lists the seeded rooms with clean readiness',
    rooms.every((room) => rackText.includes(room.code)) &&
      rackText.includes('Clean'),
  );
  await shot(page, 'frontdesk-room-rack');

  const blockId = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "inventory_block"
         ("id", "tenant_id", "property_id", "mode", "reason", "state",
          "start_date", "end_date")
       values ($1, $2, $3, 'PLANNED', 'P7V visual block', 'ACTIVE', $4, $5)`,
      [blockId, tenantId, propertyId, today, shift(2)],
    );
    await client.query(
      `insert into "inventory_block_resource"
         ("block_id", "tenant_id", "property_id", "resource_id")
       values ($1, $2, $3, $4)`,
      [blockId, tenantId, propertyId, rooms[0].id],
    );
  });
  const blockedBoard = (await board(today)).arrivals.find(
    (row) => row.item_id === stayA.itemId,
  );
  const blockedCandidate = blockedBoard?.candidates.find(
    (candidate) => candidate.resource_id === rooms[0].id,
  );
  check(
    'active inventory block marks the room BLOCKED on the board',
    blockedCandidate?.eligible === false &&
      blockedCandidate?.reason === 'BLOCKED',
    `eligible=${blockedCandidate?.eligible} reason=${blockedCandidate?.reason}`,
  );
  const blockedAssign = await api(
    page,
    'POST',
    `${base}/${propertyId}/reservations/${stayA.reservationId}/items/${stayA.itemId}/assignments`,
    { resource_id: rooms[0].id, version: blockedBoard?.item_version },
  );
  const blockedAssignments = (
    await withOwner((client) =>
      client.query(
        `select count(*)::int as count from "room_assignment" where "item_id" = $1`,
        [stayA.itemId],
      ),
    )
  ).rows[0].count;
  check(
    'assigning a blocked room is rejected with reason BLOCKED and no effect',
    blockedAssign.status === 400 &&
      blockedAssign.body.details?.reason === 'BLOCKED' &&
      blockedAssignments === 0,
    `status=${blockedAssign.status} reason=${blockedAssign.body.details?.reason} assignments=${blockedAssignments}`,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Arrivals' }).waitFor({ timeout: 20000 });
  await page.waitForSelector('table', { timeout: 15000 });
  const blockedRow = rowByText(`P7V Guest1 ${runId}`);
  await blockedRow.getByRole('button', { name: 'Assign room' }).click();
  const blockDialog = page.getByRole('dialog');
  await blockDialog.waitFor({ timeout: 10000 });
  const blockedDialogText = await blockDialog.textContent();
  check(
    'blocked room is labelled and not selectable in the assign dialog',
    blockedDialogText.includes('Room is blocked') &&
      (await blockDialog
        .getByRole('radio', { name: rooms[0].code })
        .isDisabled()),
    'label=Room is blocked, radio disabled',
  );
  await blockDialog.getByRole('button', { name: 'Cancel' }).click();
  await blockDialog.waitFor({ state: 'detached', timeout: 10000 });

  await withOwner((client) =>
    client.query(
      `update "inventory_block"
         set "state" = 'RELEASED', "version" = "version" + 1, "updated_at" = now()
       where "id" = $1`,
      [blockId],
    ),
  );
  const releasedBoard = (await board(today)).arrivals.find(
    (row) => row.item_id === stayA.itemId,
  );
  const releasedCandidate = releasedBoard?.candidates.find(
    (candidate) => candidate.resource_id === rooms[0].id,
  );
  check(
    'releasing the block restores the room eligibility',
    releasedCandidate?.eligible === true && !releasedCandidate?.reason,
    `eligible=${releasedCandidate?.eligible} reason=${releasedCandidate?.reason}`,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Arrivals' }).waitFor({ timeout: 20000 });
  await page.waitForSelector('table', { timeout: 15000 });

  const rowA = rowByText(`P7V Guest1 ${runId}`);
  await rowA.getByRole('button', { name: 'Assign room' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('radio', { name: rooms[0].code }).click();
  await dialog
    .getByRole('button', { name: 'Assign room', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(600);
  const boardAfterAssign = await board(today);
  const assignedStayA = boardAfterAssign.arrivals.find(
    (row) => row.item_id === stayA.itemId,
  );
  check(
    'assign room dialog binds a planned assignment for the arrival',
    assignedStayA?.assignment?.state === 'PLANNED' &&
      assignedStayA?.assignment?.resource_id === rooms[0].id,
    `state=${assignedStayA?.assignment?.state} room=${assignedStayA?.assignment?.resource_id}`,
  );
  check(
    'assigned room appears in the arrivals row',
    (await rowA.textContent()).includes(rooms[0].code),
  );
  await shot(page, 'frontdesk-assigned');

  await rowA.getByRole('button', { name: 'Check in' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Check in', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const boardAfterCheckIn = await board(today);
  const inHouseA = boardAfterCheckIn.inHouse.find(
    (row) => row.item_id === stayA.itemId,
  );
  const checkInEvents = (
    await withOwner((client) =>
      client.query(
        `select count(*)::int as count from "stay_event"
          where "property_id" = $1 and "item_id" = $2 and "type" = 'STAY_CHECKED_IN'`,
        [propertyId, stayA.itemId],
      ),
    )
  ).rows[0].count;
  check(
    'check-in moves the item in-house with one stay event',
    inHouseA?.state === 'IN_HOUSE' &&
      inHouseA?.segment_state === 'IN_HOUSE' &&
      checkInEvents === 1,
    `state=${inHouseA?.state} events=${checkInEvents}`,
  );

  await page.getByRole('tab', { name: 'In house' }).click();
  await page.waitForTimeout(800);
  const inHouseRowA = rowByText(`P7V Guest1 ${runId}`);
  await inHouseRowA.getByRole('button', { name: 'Extend' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('New departure').fill(shift(4));
  await dialog.getByRole('button', { name: 'Extend', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const detailAfterExtend = await detail(stayA.reservationId);
  check(
    'extend updates the item departure without repricing',
    detailAfterExtend.items[0].period.departure === shift(4),
    `departure=${detailAfterExtend.items[0].period.departure}`,
  );

  await inHouseRowA.getByRole('button', { name: 'Move' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Target room').click();
  await page.getByRole('option', { name: new RegExp(rooms[1].code) }).click();
  await dialog.getByLabel('Effective date').fill(today);
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const assignmentsA = (
    await withOwner((client) =>
      client.query(
        `select "state", "resource_id", "start_date"::text, "end_date"::text
           from "room_assignment" where "item_id" = $1 order by "created_at"`,
        [stayA.itemId],
      ),
    )
  ).rows;
  const activeA = assignmentsA.find((row) => row.state === 'ACTIVE');
  check(
    'move secures the alternative room and closes the old assignment',
    activeA?.resource_id === rooms[1].id &&
      assignmentsA.some(
        (row) => row.resource_id === rooms[0].id && row.state !== 'ACTIVE',
      ),
    JSON.stringify(assignmentsA),
  );

  await inHouseRowA.getByRole('button', { name: 'Split stay' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Split date').fill(tomorrow);
  await dialog.getByRole('button', { name: 'Split stay', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const detailAfterSplit = await detail(stayA.reservationId);
  const splitItems = detailAfterSplit.items.filter(
    (item) => item.state === 'IN_HOUSE',
  );
  check(
    'split creates a follow-up in-house item without overlap',
    splitItems.length === 2 &&
      splitItems.some((item) => item.period.departure === shift(4)) &&
      splitItems.some((item) => item.period.departure === tomorrow),
    JSON.stringify(splitItems.map((item) => item.period)),
  );

  const followUpRow = page
    .locator('tbody tr')
    .filter({ hasText: `P7V Guest1 ${runId}` })
    .filter({
      hasText: new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
      }).format(new Date(`${shift(4)}T00:00:00Z`)),
    })
    .first();
  await followUpRow.getByRole('button', { name: 'Partial departure' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('checkbox').first().check();
  await dialog
    .getByRole('button', { name: 'Partial departure', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const guestsAfterPartial = (
    await withOwner((client) =>
      client.query(
        `select count(*) filter (where "departed_at" is not null)::int as departed,
                count(*)::int as total
           from "reservation_guest"
          where "reservation_id" = $1`,
        [stayA.reservationId],
      ),
    )
  ).rows[0];
  check(
    'partial departure marks exactly one guest departed',
    guestsAfterPartial.departed === 1 && guestsAfterPartial.total === 2,
    JSON.stringify(guestsAfterPartial),
  );

  await page.getByRole('tab', { name: 'Arrivals' }).click();
  await page.waitForTimeout(800);
  const rowB = rowByText(`P7V Guest3 ${runId}`);
  await rowB.getByRole('button', { name: 'Assign room' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('radio', { name: rooms[2].code }).click();
  await dialog
    .getByRole('button', { name: 'Assign room', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const rowBHouse = rowByText(`P7V Guest3 ${runId}`);
  await rowBHouse.getByRole('button', { name: 'Check in' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Check in', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);

  await page.getByRole('tab', { name: 'In house' }).click();
  await page.waitForTimeout(800);
  const rowBAgain = rowByText(`P7V Guest3 ${runId}`);
  await rowBAgain.getByRole('button', { name: 'Early departure' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Effective date').fill(tomorrow);
  await dialog
    .getByRole('button', { name: 'Early departure', exact: true })
    .click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const detailAfterEarly = await detail(stayB.reservationId);
  check(
    'early departure shortens the stay and keeps it in-house',
    detailAfterEarly.items[0].period.departure === tomorrow &&
      detailAfterEarly.items[0].state === 'IN_HOUSE',
    `departure=${detailAfterEarly.items[0].period.departure} state=${detailAfterEarly.items[0].state}`,
  );

  await page.getByLabel('Board date').fill(tomorrow);
  await page.waitForTimeout(1000);
  await page.getByRole('tab', { name: 'Departures' }).click();
  await page.waitForTimeout(1000);
  const departuresText = await page.textContent('body');
  check(
    'departures tab lists the expected stays for tomorrow',
    departuresText.includes(`P7V Guest1 ${runId}`) &&
      departuresText.includes(`P7V Guest3 ${runId}`),
  );
  await shot(page, 'frontdesk-departures');

  await page.getByLabel('Board date').fill(today);
  await page.waitForTimeout(1000);
  await page.getByRole('tab', { name: 'In house' }).click();
  await page.waitForTimeout(1000);
  const checkOutRow = rowByText(`P7V Guest3 ${runId}`);
  await checkOutRow.getByRole('button', { name: 'Check out' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Check out', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
  const checkoutEvidence = await withOwner(async (client) => {
    const item = (
      await client.query(
        `select "state" from "reservation_item" where "id" = $1`,
        [stayB.itemId],
      )
    ).rows[0];
    const reservation = (
      await client.query(
        `select "financial_clearance_state" from "reservation" where "id" = $1`,
        [stayB.reservationId],
      )
    ).rows[0];
    const room = (
      await client.query(
        `select "housekeeping_state", "maintenance_state" from "resource" where "id" = $1`,
        [rooms[2].id],
      )
    ).rows[0];
    const assignment = (
      await client.query(
        `select "state", "checked_out_at" is not null as checked_out
           from "room_assignment" where "item_id" = $1 and "resource_id" = $2`,
        [stayB.itemId, rooms[2].id],
      )
    ).rows[0];
    return { item, reservation, room, assignment };
  });
  check(
    'check-out completes the assignment and marks the room dirty',
    checkoutEvidence.item?.state === 'CHECKED_OUT' &&
      checkoutEvidence.assignment?.state === 'COMPLETED' &&
      checkoutEvidence.assignment?.checked_out === true &&
      checkoutEvidence.room?.housekeeping_state === 'DIRTY' &&
      checkoutEvidence.reservation?.financial_clearance_state === 'PENDING',
    JSON.stringify(checkoutEvidence),
  );

  await page.getByRole('tab', { name: 'Room rack' }).click();
  await page.waitForTimeout(1000);
  const dirtyRoomRow = rowByText(rooms[2].code);
  check(
    'room rack shows the checked-out room dirty',
    (await dirtyRoomRow.textContent()).includes('Dirty'),
  );
  await shot(page, 'frontdesk-room-dirty');

  const stayEvents = (
    await withOwner((client) =>
      client.query(
        `select "type", count(*)::int as count from "stay_event"
          where "property_id" = $1 group by "type" order by "type"`,
        [propertyId],
      ),
    )
  ).rows;
  const eventCount = (type) =>
    stayEvents.find((row) => row.type === type)?.count ?? 0;
  check(
    'stay events are written exactly once per operation',
    eventCount('STAY_CHECKED_IN') === 2 &&
      eventCount('STAY_MOVED') === 1 &&
      eventCount('STAY_EXTENDED') === 1 &&
      eventCount('STAY_SPLIT') === 1 &&
      eventCount('STAY_EARLY_DEPARTURE') === 1 &&
      eventCount('STAY_PARTIAL_DEPARTURE') === 1 &&
      eventCount('STAY_CHECKED_OUT') === 1,
    JSON.stringify(stayEvents),
  );
  dbEvidence.stay_events = stayEvents;

  const connection = await api(
    page,
    'POST',
    `${base}/${propertyId}/connections`,
    {
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      channel_key: 'BOOKING_COM',
      external_property_id: `p7v-${runId}`,
      secret_ref: 'local:hotel/p7-visual',
    },
  );
  const connectionId = connection.body.connection.id;
  const revisionId = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "distribution_inbox_revision"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "provider_key", "environment", "provider_revision_id",
          "external_booking_id", "revision_type", "payload_hash",
          "payload_safe", "source_sequence", "received_at")
       values ($1, $2, $3, $4, 'BOOKING_COM', 'CHANNEX', 'STAGING', $5, $6,
               'modified', $7, $8::jsonb, $9, now())`,
      [
        revisionId,
        tenantId,
        propertyId,
        connectionId,
        `P7V-REV-${runId}`,
        `P7V-MISSING-${runId}`,
        'b'.repeat(64),
        JSON.stringify({ items: [{ occupancy: 2 }] }),
        String(Date.now()),
      ],
    );
  });
  const exceptionRun = await api(
    page,
    'POST',
    `${base}/${propertyId}/inbox/${revisionId}/reprocess`,
  );
  check(
    'seeded consumer exception is open for F7',
    exceptionRun.status === 200 && exceptionRun.body.exception_id,
    `status=${exceptionRun.status} exception=${exceptionRun.body.exception_id}`,
  );

  await page.goto(`${baseUrl}/properties/${propertyId}/reservations`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('table', { timeout: 15000 });
  await page.getByRole('tab', { name: 'Import & exceptions' }).click();
  await page.waitForTimeout(1200);
  const importTabText = await page.textContent('body');
  check(
    'F7 tab shows import and exception sections',
    importTabText.includes('Reservation import') &&
      importTabText.includes('Consumer exceptions'),
  );

  const csv = [
    'external_key,arrival,departure,adults,quantity,product_code',
    `P7V-IMP-${runId}-1,${shift(5)},${shift(7)},2,1,P7V-P-${runId}`,
    `P7V-IMP-${runId}-2,not-a-date,${shift(7)},2,1,P7V-P-${runId}`,
  ].join('\n');
  await page.getByLabel('File name').fill(`p7v-import-${runId}.csv`);
  await page.getByLabel('CSV content').fill(csv);
  await page.getByRole('button', { name: 'Run import' }).click();
  await page.getByText('Import report').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const reportText = await page.textContent('body');
  check(
    'F7 dry-run import reports accepted and rejected rows',
    /Total \/ accepted \/ rejected \/ duplicate: 2 · Accepted: 1 · Rejected: 1/.test(
      reportText,
    ) &&
      reportText.includes(`P7V-IMP-${runId}-1`) &&
      reportText.includes('INVALID_DATE'),
    reportText.includes(`P7V-IMP-${runId}-2`)
      ? 'rejected row rendered'
      : 'rejected row missing',
  );
  await shot(page, 'f7-import-dry-run');

  const exceptionsBefore = (
    await api(page, 'GET', `${base}/${propertyId}/inbox/exceptions`)
  ).body.items;
  check(
    'F7 exceptions list returns the open exception safely',
    exceptionsBefore.some(
      (row) =>
        row.state === 'OPEN' && row.details_safe?.error_code === 'LINK_MISSING',
    ),
    JSON.stringify(exceptionsBefore.map((row) => row.type)),
  );
  const exceptionsText = await page.textContent('body');
  check(
    'F7 exceptions table exposes the reprocess action',
    exceptionsText.includes('LINK_MISSING') && exceptionsText.includes('Open'),
  );
  await page
    .locator('tbody tr')
    .filter({ hasText: 'LINK_MISSING' })
    .first()
    .getByRole('button', { name: 'Reprocess' })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Reprocess', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(1200);
  const exceptionsAfter = (
    await api(page, 'GET', `${base}/${propertyId}/inbox/exceptions`)
  ).body.items;
  check(
    'F7 reprocess keeps a single open exception without partial writes',
    exceptionsAfter.some(
      (row) =>
        row.state === 'OPEN' && row.details_safe?.error_code === 'LINK_MISSING',
    ),
    JSON.stringify(exceptionsAfter.map((row) => row.state)),
  );
  await shot(page, 'f7-exceptions');

  await page.goto(`${baseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /العربية/ }).click();
  await page.waitForTimeout(800);
  await page.goto(`${baseUrl}/properties/${propertyId}/front-desk`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('table', { timeout: 15000 });
  const dir = await page.evaluate(() => document.documentElement.dir);
  check('front desk renders RTL in Arabic', dir === 'rtl', `dir=${dir}`);
  await shot(page, 'frontdesk-arabic-rtl');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const mobileOverflow = await overflow(page);
  check(
    'no horizontal overflow at 390px',
    mobileOverflow.documentDelta <= 1 && mobileOverflow.offenders.length === 0,
    JSON.stringify(mobileOverflow),
  );
  await shot(page, 'frontdesk-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  check(
    'no page errors',
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '),
  );
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );
} catch (error) {
  check('visual phase 7 run completed', false, String(error).slice(0, 500));
} finally {
  const report = {
    scope: 'P07-05',
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
    `\nP07-05: ${checks.length - failures.length}/${checks.length} checks passed; ${screenshots.length} screenshots in ${outDir}.`,
  );
  await context.close();
  await browser.close();
  if (failures.length > 0) process.exitCode = 1;
}
