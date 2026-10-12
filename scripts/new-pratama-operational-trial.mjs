import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';

// Root supplies the restored clone and runtime. Never start services or create geometry.
const database = 'hotel_np_operational_trial_20261009';
const tenant = '4e4da283-994c-41af-93ce-54b7fa89814e';
const property = 'f5651217-3100-4da5-91ec-d3fe1775db7c';
const base = `/tenants/${tenant}/properties/${property}`;
const apply = process.argv.includes('--apply');
assert.ok(
  process.argv.includes('--readiness') || apply,
  'Use --readiness or --apply',
);
const env = (name) => {
  assert.ok(process.env[name], `${name} required`);
  return process.env[name];
};
function target(value) {
  const url = new URL(value);
  assert.equal(
    url.pathname,
    `/${database}`,
    'Only the operational clone is allowed',
  );
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Local DB only');
  return `${url.hostname.replace('localhost', '127.0.0.1')}:${url.port || '5432'}${url.pathname}`;
}
const dbUrl = env('TEST_DATABASE_URL');
const dbTarget = target(dbUrl);
assert.equal(env('IDENTITY_TEST_DB'), database);
assert.equal(target(env('API_DATABASE_URL')), dbTarget);
assert.equal(target(env('WORKER_DATABASE_URL')), dbTarget);
assert.equal(
  target(env('DATABASE_URL')),
  dbTarget,
  'Harness owner connection must also be clone',
);
function processGuard(pidKey, service, dbKey, portKey, requestedPortKey) {
  const pid = env(pidKey);
  assert.match(pid, /^\d+$/);
  assert.ok(
    readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
      `apps/${service}/dist/main.js`,
    ),
  );
  const runtime = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const entry = runtime.find((item) => item.startsWith(`${dbKey}=`));
  assert.ok(entry, `${service} runtime DB required`);
  assert.equal(target(entry.slice(dbKey.length + 1)), dbTarget);
  const runtimeValue = (key) =>
    runtime.find((item) => item.startsWith(`${key}=`))?.slice(key.length + 1);
  const requestedPort = env(requestedPortKey);
  assert.match(requestedPort, /^\d+$/);
  assert.ok(Number(requestedPort) >= 1024 && Number(requestedPort) <= 65535);
  assert.equal(runtimeValue(portKey), requestedPort, `${service} runtime port`);
  assert.equal(runtimeValue('API_HOST'), '127.0.0.1');
  if (service === 'api')
    assert.equal(runtimeValue('WEB_PORT'), env('WEB_PORT'), 'API origin port');
  const socketInodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const socket = readlinkSync(`/proc/${pid}/fd/${fd}`).match(
        /^socket:\[(\d+)\]$/,
      );
      if (socket) socketInodes.add(socket[1]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const portHex = Number(requestedPort)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');
  const address = `0100007F:${portHex}`;
  const listening = readFileSync(`/proc/${pid}/net/tcp`, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .some((line) => {
      const fields = line.trim().split(/\s+/);
      return (
        fields[1] === address &&
        fields[3] === '0A' &&
        socketInodes.has(fields[9])
      );
    });
  assert.ok(
    listening,
    `${service} PID must own the requested loopback listener`,
  );
}
const baselineBytes = readFileSync(env('NP_TRIAL_BASELINE'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(sha(baselineBytes), env('NP_TRIAL_BASELINE_SHA256'));
const baseline = JSON.parse(baselineBytes);
assert.equal(baseline.status, 'PASS_READ_ONLY_DB_INVARIANTS');
assert.equal(baseline.counts.resources, 97);
assert.equal(baseline.counts.room_atoms, 73);
assert.equal(baseline.counts.villas, 24);
assert.equal(baseline.rows.location.length, 44);
const folder = '.local/verification/NP-operational-trial-20261009';
const runId = process.env.NP_TRIAL_RUN_ID ?? null;
if (runId !== null) assert.match(runId, /^[a-z0-9][a-z0-9_-]{0,39}$/);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const journalPath = `${folder}/journal${runId === null ? '' : `-${runId}`}.json`;
const initial = {
  database,
  run_id: runId,
  baseline_sha: sha(baselineBytes),
  script_sha: sha(readFileSync(new URL(import.meta.url))),
  steps: {},
  events: [],
};
const journal = existsSync(journalPath)
  ? JSON.parse(readFileSync(journalPath))
  : initial;
assert.equal(journal.database, database);
assert.equal(journal.run_id ?? null, runId);
assert.equal(journal.baseline_sha, initial.baseline_sha);
assert.equal(
  journal.script_sha,
  initial.script_sha,
  'Source changed: do not replay under a different script',
);
function save() {
  const tmp = `${journalPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tmp, journalPath);
}
const db = new Client({ connectionString: dbUrl });
await db.connect();
await db.query('SET default_transaction_read_only = on');
let harness;
let account;
const normalized = (value) => JSON.parse(JSON.stringify(value));
const ordered = (items) =>
  normalized(items).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
const rows = async (table) =>
  normalized((await db.query(`SELECT * FROM "${table}"`)).rows);
const geometryFields = [
  'id',
  'tenant_id',
  'property_id',
  'code',
  'resource_type',
  'state',
  'maintenance_state',
  'housekeeping_state',
  'capacity',
  'parent_resource_id',
  'location_id',
  'unit_details',
  'display_label',
];
const projection = (items, fields) =>
  items
    .map((row) =>
      Object.fromEntries(
        fields.map((key) => {
          assert.ok(Object.hasOwn(row, key), `Required geometry field ${key}`);
          return [key, row[key]];
        }),
      ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
async function guard() {
  processGuard(
    'NP_TRIAL_API_PID',
    'api',
    'API_DATABASE_URL',
    'API_PORT',
    'API_PORT',
  );
  processGuard(
    'NP_TRIAL_WORKER_PID',
    'worker',
    'WORKER_DATABASE_URL',
    'WORKER_PORT',
    'NP_TRIAL_WORKER_PORT',
  );
  assert.equal(
    (await db.query('SELECT current_database() AS name')).rows[0].name,
    database,
  );
  const properties = await rows('property');
  assert.equal(properties.length, 1);
  assert.equal(properties[0].id, property);
  assert.equal(properties[0].tenant_id, tenant);
  assert.equal(properties[0].timezone, 'Asia/Jakarta');
  assert.equal(properties[0].base_currency, 'IDR');
  assert.equal(properties[0].name, 'new pratama');
  assert.ok(
    properties[0].status === 'SETUP' ||
      (journal.steps.activate && properties[0].status === 'ACTIVE'),
  );
  const resources = await rows('resource');
  const trialRoom = resources.find((row) => row.code === 'V04-R01');
  let expectedResources = baseline.rows.resource;
  if (journal.steps.checkout && trialRoom?.housekeeping_state === 'DIRTY') {
    const itemId = journal.steps['confirm-stay']?.request.body.items[0].item_id;
    assert.ok(itemId, 'Checkout must belong to the confirmed trial stay');
    const checkedOut = (
      await db.query(
        `SELECT i.state, count(e.id)::int AS events
           FROM reservation_item i LEFT JOIN stay_event e
             ON e.item_id = i.id AND e.tenant_id = i.tenant_id
             AND e.property_id = i.property_id
             AND e.type = 'STAY_CHECKED_OUT' AND e.resource_id = $4
          WHERE i.id = $1 AND i.tenant_id = $2 AND i.property_id = $3
          GROUP BY i.state`,
        [itemId, tenant, property, trialRoom.id],
      )
    ).rows;
    assert.deepEqual(checkedOut, [{ state: 'CHECKED_OUT', events: 1 }]);
    expectedResources = baseline.rows.resource.map((row) =>
      row.id === trialRoom.id ? { ...row, housekeeping_state: 'DIRTY' } : row,
    );
  }
  if (journal.steps.checkout?.state === 'DONE')
    assert.equal(trialRoom?.housekeeping_state, 'DIRTY');
  assert.deepEqual(
    projection(resources, geometryFields),
    projection(expectedResources, geometryFields),
  );
  assert.equal(resources.length, 97);
  for (const table of [
    'location',
    'product_resource_candidate',
    'composition_version',
    'composition_edge',
    'composition_leaf',
  ])
    assert.deepEqual(
      ordered(await rows(table)),
      ordered(baseline.rows[table]),
      `Unchanged ${table}`,
    );
  const products = await rows('product');
  assert.deepEqual(
    projection(products, [
      'id',
      'tenant_id',
      'property_id',
      'code',
      'kind',
      'status',
      'occupancy_adults_min',
      'occupancy_adults_max',
      'occupancy_children_max',
    ]),
    projection(baseline.rows.product, [
      'id',
      'tenant_id',
      'property_id',
      'code',
      'kind',
      'status',
      'occupancy_adults_min',
      'occupancy_adults_max',
      'occupancy_children_max',
    ]),
  );
  for (const table of ['distribution_connection', 'exposure'])
    assert.equal(
      Number(
        (await db.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n,
      ),
      0,
      `No channels: ${table}`,
    );
  return { properties, resources, products };
}
async function call(method, path, body, key) {
  assert.ok(
    path === base ||
      path.startsWith(`${base}/`) ||
      path === `/tenants/${tenant}/guests`,
    'Only trial scope API',
  );
  if (method !== 'GET') await guard();
  const response = await harness.apiRequest(account.context, method, path, {
    ...(body === undefined ? {} : { body }),
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });
  // Store only JSON API payloads, never cookies, tokens, headers or environment.
  journal.events.push({
    method,
    path,
    request: body ?? null,
    status: response.status,
    response: response.body,
  });
  save();
  return response;
}
async function get(path) {
  const response = await call('GET', path);
  assert.equal(response.status, 200);
  return response.body;
}
async function step(name, method, path, body, expected, replayable = false) {
  await guard();
  const key = `np-operational-20261009${runId === null ? '' : `-${runId}`}-${name}`;
  const previous = journal.steps[name];
  if (previous) {
    assert.deepEqual(
      { method, path, body },
      previous.request,
      `Changed intent ${name}`,
    );
    if (previous.state === 'DONE') return previous.response;
    assert.ok(
      replayable,
      `Unknown non-idempotent outcome for ${name}: read-only reconciliation required; do not retry blindly`,
    );
  } else {
    journal.steps[name] = {
      state: 'INTENT',
      request: { method, path, body },
      key,
    };
    save();
  }
  const result = await call(method, path, body, key);
  assert.equal(
    result.status,
    expected,
    `${name}: ${result.body?.code ?? result.status}`,
  );
  journal.steps[name] = {
    ...journal.steps[name],
    state: 'DONE',
    response: result.body,
  };
  save();
  return result.body;
}
const date = (day, offset = 0) => {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
async function freshClone() {
  for (const table of [
    'reservation',
    'guest',
    'rate_plan',
    'nightly_price',
    'folio',
    'folio_payment',
    'journal',
  ])
    assert.equal(
      Number(
        (await db.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n,
      ),
      0,
      `Fresh clone: ${table}`,
    );
}
try {
  const scope = await guard();
  for (const [port, path] of [
    [Number(env('API_PORT')), '/api/v1/system/ready'],
    [Number(env('NP_TRIAL_WORKER_PORT')), '/ready'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 200);
  }
  if (!apply) {
    assert.equal(scope.properties[0].status, 'SETUP');
    await freshClone();
    journal.readiness = {
      status: 'PASS_READ_ONLY',
      resources: 97,
      room_atoms: 73,
      villas: 24,
      at: new Date().toISOString(),
    };
    save();
    console.log(JSON.stringify(journal.readiness));
  } else {
    assert.equal(
      journal.readiness?.status,
      'PASS_READ_ONLY',
      'Run --readiness on fresh clone first',
    );
    if (Object.keys(journal.steps).length === 0) await freshClone();
    harness = await import('../tests/property/support/harness.mjs');
    account = await harness.loginAs(env('NP_TRIAL_LOGIN'));
    assert.equal(account.session.body.session.active_tenant_id, tenant);
    const current = await get(base);
    await step(
      'activate',
      'PATCH',
      base,
      journal.steps.activate?.request.body ?? {
        version: current.property.version,
        status: 'ACTIVE',
      },
      200,
    );
    const room = scope.resources.find((row) => row.code === 'V04-R01');
    const whole = scope.resources.find((row) => row.code === 'V04');
    assert.ok(room && whole && room.parent_resource_id === whole.id);
    const roomCandidate = baseline.rows.product_resource_candidate.find(
      (row) => row.resource_id === room.id,
    );
    const wholeWindows = (
      await db.query(
        `SELECT v.id, v.product_id,
      v.effective_from::text AS start, v.effective_to::text AS finish
      FROM composition_version v JOIN composition_leaf l ON l.version_id = v.id
      WHERE l.resource_id = $1 AND v.effective_from = DATE '2026-10-09'
        AND v.effective_to = DATE '2031-10-08' AND v.status = 'ACTIVE'`,
        [room.id],
      )
    ).rows;
    assert.equal(wholeWindows.length, 1, 'Exact authorized current V04 window');
    const wholeComposition = wholeWindows[0];
    assert.ok(
      baseline.rows.composition_version.some(
        (row) =>
          row.id === wholeComposition.id &&
          row.product_id === wholeComposition.product_id,
      ),
    );
    const roomProduct = scope.products.find(
      (row) => row.id === roomCandidate?.product_id,
    );
    // Product code is mapped from the actual baseline, never recreated.
    const wholeProduct = scope.products.find(
      (row) => row.id === wholeComposition?.product_id,
    );
    assert.ok(
      roomProduct && wholeProduct,
      'Actual room and dated whole-product mapping required',
    );
    const business = await get(`${base}/finance/business-day`);
    const today = journal.business_date ?? business.date;
    assert.equal(
      business.date,
      today,
      'Business day changed; stop instead of shifting saved trial dates',
    );
    journal.business_date = today;
    save();
    const period = { arrival: today, departure: date(today, 2) };
    const later = { arrival: date(today, 3), departure: date(today, 5) };
    const occupancy = { adults: 2, child_ages: [] };
    const plans = {};
    for (const [name, product] of [
      ['room', roomProduct],
      ['whole', wholeProduct],
    ]) {
      const created = await step(
        `plan-${name}`,
        'POST',
        `${base}/rate-plans`,
        {
          code: `NPTRIAL-${name.toUpperCase()}`,
          name: `Synthetic operational trial ${name}`,
          product_id: product.id,
          currency: 'IDR',
        },
        201,
      );
      plans[name] = created.rate_plan.id;
      await step(
        `plan-active-${name}`,
        'PATCH',
        `${base}/rate-plans/${plans[name]}`,
        { version: created.rate_plan.version, status: 'ACTIVE' },
        200,
      );
      await step(
        `prices-${name}`,
        'POST',
        `${base}/rates/batch`,
        {
          cells: Array.from({ length: 7 }, (_, offset) => ({
            rate_plan_id: plans[name],
            date: date(today, offset),
            occupancy: 2,
            money: {
              amount: name === 'room' ? '250000' : '750000',
              currency: 'IDR',
            },
          })),
        },
        200,
      );
    }
    const guest = await step(
      'guest',
      'POST',
      `/tenants/${tenant}/guests`,
      {
        full_name: 'NP Synthetic Trial Guest',
        email: 'np-operational-trial@example.invalid',
      },
      201,
    );
    const inventory = async () =>
      (await get(`${base}/rates?from=${today}&to=${date(today, 7)}`))
        .inventory_version;
    const quote = async (name, product, window, plan) =>
      (
        await step(
          `quote-${name}`,
          'POST',
          `${base}/quotes`,
          {
            product_id: product.id,
            rate_plan_id: plan,
            period: window,
            occupancy,
            quantity: 1,
          },
          201,
        )
      ).quote.id;
    async function booking(name, product, plan, window) {
      const price = await quote(name, product, window, plan);
      const draft = await step(
        `draft-${name}`,
        'POST',
        `${base}/reservations/drafts`,
        {
          source: 'DIRECT',
          guests: [{ guest_id: guest.guest.id, role: 'LEAD' }],
          items: [
            { product_id: product.id, period: window, occupancy, quantity: 1 },
          ],
        },
        201,
      );
      const detail = await get(`${base}/reservations/${draft.reservation.id}`);
      const body = journal.steps[`confirm-${name}`]?.request.body ?? {
        reservation_id: draft.reservation.id,
        inventory_version: await inventory(),
        items: [{ item_id: detail.items[0].id, price_snapshot_id: price }],
      };
      await step(
        `confirm-${name}`,
        'POST',
        `${base}/reservations`,
        body,
        200,
        true,
      );
      const replay = await call(
        'POST',
        `${base}/reservations`,
        body,
        journal.steps[`confirm-${name}`].key,
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      return {
        reservationId: draft.reservation.id,
        itemId: detail.items[0].id,
      };
    }
    async function available(name, product, window, expected) {
      const result = await call('POST', `${base}/availability/search`, {
        product_ids: [product.id],
        period: window,
        occupancy,
        quantity: 1,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.offers[0].result, expected, name);
      if (expected === 'UNAVAILABLE') {
        await step(
          `blocked-hold-${name.replaceAll(' ', '-')}`,
          'POST',
          `${base}/holds`,
          {
            items: [
              {
                product_id: product.id,
                period: window,
                occupancy,
                quantity: 1,
              },
            ],
            ttl_seconds: 300,
            inventory_version: await inventory(),
          },
          409,
        );
        assert.equal(
          journal.steps[`blocked-hold-${name.replaceAll(' ', '-')}`].response
            .code,
          'RESOURCE_UNAVAILABLE',
        );
      }
    }
    async function cancel(name, item) {
      const detail = await get(`${base}/reservations/${item.reservationId}`);
      await step(
        `cancel-${name}`,
        'POST',
        `${base}/reservation-items/${item.itemId}/cancel`,
        journal.steps[`cancel-${name}`]?.request.body ?? {
          version: detail.items.find((row) => row.id === item.itemId).version,
          reason: 'Synthetic isolated operational trial',
        },
        200,
      );
      assert.equal(
        Number(
          (
            await db.query(
              'SELECT count(*) AS n FROM commitment WHERE source_id = $1 AND state = $2',
              [item.itemId, 'ACTIVE'],
            )
          ).rows[0].n,
        ),
        0,
        'Cancel releases active commitment',
      );
    }
    const first = await booking('room-first', roomProduct, plans.room, period);
    if (!journal.steps['modify-room'])
      await available('room blocks whole', wholeProduct, period, 'UNAVAILABLE');
    const newPrice = await quote(
      'room-modified',
      roomProduct,
      later,
      plans.room,
    );
    const detail = await get(`${base}/reservations/${first.reservationId}`);
    await step(
      'modify-room',
      'PATCH',
      `${base}/reservations/${first.reservationId}`,
      journal.steps['modify-room']?.request.body ?? {
        version: detail.reservation.version,
        items: [
          { item_id: first.itemId, period: later, price_snapshot_id: newPrice },
        ],
      },
      200,
    );
    if (!journal.steps['cancel-room-first'])
      await available(
        'modify released original whole',
        wholeProduct,
        period,
        'AVAILABLE',
      );
    await cancel('room-first', first);
    if (!journal.steps['confirm-whole-first'])
      await available(
        'cancel released later whole',
        wholeProduct,
        later,
        'AVAILABLE',
      );
    const second = await booking(
      'whole-first',
      wholeProduct,
      plans.whole,
      period,
    );
    if (!journal.steps['cancel-whole-first'])
      await available('whole blocks room', roomProduct, period, 'UNAVAILABLE');
    await cancel('whole-first', second);
    if (!journal.steps['confirm-stay'])
      await available(
        'whole cancel releases room',
        roomProduct,
        period,
        'AVAILABLE',
      );
    const stay = await booking('stay', roomProduct, plans.room, period);
    const stayDetail = await get(`${base}/reservations/${stay.reservationId}`);
    await step(
      'checkin',
      'POST',
      `${base}/reservations/${stay.reservationId}/items/${stay.itemId}/check-in`,
      journal.steps.checkin?.request.body ?? {
        version: stayDetail.items[0].version,
        resource_id: room.id,
      },
      200,
      true,
    );
    const inReplay = await call(
      'POST',
      `${base}/reservations/${stay.reservationId}/items/${stay.itemId}/check-in`,
      journal.steps.checkin.request.body,
      journal.steps.checkin.key,
    );
    assert.equal(inReplay.status, 200);
    assert.equal(inReplay.body.replayed, true);
    const folio = await step(
      'folio',
      'POST',
      `${base}/folios`,
      {
        reservation_id: stay.reservationId,
        payer_label: 'NP Synthetic Trial Guest',
        currency: 'IDR',
      },
      200,
      true,
    );
    assert.equal(folio.folio.reservation_id, stay.reservationId);
    assert.equal(folio.folio.currency, 'IDR');
    const paymentBody = {
      folio_id: folio.folio.id,
      method: 'CASH',
      money: { amount: '500000', currency: 'IDR' },
      business_date: today,
      external_reference: 'np-trial-cash',
      source_ref: 'np-trial-cash',
    };
    const payment = await step(
      'cash',
      'POST',
      `${base}/payments`,
      paymentBody,
      200,
      true,
    );
    assert.equal(payment.state, 'SUCCEEDED');
    assert.equal(payment.folio_id, folio.folio.id);
    assert.equal(payment.currency, 'IDR');
    assert.equal(payment.amount.replace(/\.0+$/, ''), '500000');
    assert.ok(payment.journal_id);
    const replay = await call(
      'POST',
      `${base}/payments`,
      paymentBody,
      journal.steps.cash.key,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, payment.id);
    assert.equal(replay.body.replayed, true);
    const outDetail = await get(`${base}/reservations/${stay.reservationId}`);
    await step(
      'checkout',
      'POST',
      `${base}/reservations/${stay.reservationId}/items/${stay.itemId}/check-out`,
      journal.steps.checkout?.request.body ?? {
        version: outDetail.items[0].version,
      },
      200,
      true,
    );
    const checkReplay = await call(
      'POST',
      `${base}/reservations/${stay.reservationId}/items/${stay.itemId}/check-out`,
      journal.steps.checkout.request.body,
      journal.steps.checkout.key,
    );
    assert.equal(checkReplay.status, 200);
    assert.equal(checkReplay.body.replayed, true);
    const balance = (
      await db.query(
        'SELECT journal_id FROM journal_line GROUP BY journal_id HAVING sum(debit) <> sum(credit)',
      )
    ).rows;
    assert.equal(balance.length, 0, 'Every journal balances');
    const cashRows = (
      await db.query(
        `SELECT p.id, p.folio_id, p.method, p.currency, p.amount::text,
                p.business_date::text, p.state, p.journal_id,
                f.reservation_id, f.currency AS folio_currency,
                j.currency AS journal_currency, j.source_type,
                j.state AS journal_state, j.business_date::text AS journal_date,
                j.total_debit::text, j.total_credit::text
           FROM folio_payment p JOIN folio f
             ON f.id = p.folio_id AND f.tenant_id = p.tenant_id
             AND f.property_id = p.property_id
           JOIN journal j ON j.id = p.journal_id
             AND j.tenant_id = p.tenant_id AND j.property_id = p.property_id
          WHERE p.source_ref = $1 AND p.tenant_id = $2 AND p.property_id = $3`,
        ['np-trial-cash', tenant, property],
      )
    ).rows;
    assert.equal(
      cashRows.length,
      1,
      'One persisted payment linked to folio/journal',
    );
    const persistedPayments = await rows('folio_payment');
    assert.equal(persistedPayments.length, 1, 'One payment after replay');
    assert.equal(persistedPayments[0].id, payment.id);
    assert.deepEqual(cashRows[0], {
      id: payment.id,
      folio_id: folio.folio.id,
      method: 'CASH',
      currency: 'IDR',
      amount: '500000.000000',
      business_date: today,
      state: 'SUCCEEDED',
      journal_id: payment.journal_id,
      reservation_id: stay.reservationId,
      folio_currency: 'IDR',
      journal_currency: 'IDR',
      source_type: 'PAYMENT',
      journal_state: 'POSTED',
      journal_date: today,
      total_debit: '500000.000000',
      total_credit: '500000.000000',
    });
    const cashLines = (
      await db.query(
        `SELECT account_code, debit::text, credit::text FROM journal_line
          WHERE journal_id = $1 AND tenant_id = $2 AND property_id = $3
          ORDER BY line_no`,
        [payment.journal_id, tenant, property],
      )
    ).rows;
    assert.deepEqual(cashLines, [
      { account_code: 'CASH', debit: '500000.000000', credit: '0.000000' },
      {
        account_code: 'FOLIO_GUEST',
        debit: '0.000000',
        credit: '500000.000000',
      },
    ]);
    assert.equal(
      Number(
        (
          await db.query(
            `SELECT count(*) AS n FROM journal
              WHERE source_type = 'PAYMENT' AND tenant_id = $1 AND property_id = $2`,
            [tenant, property],
          )
        ).rows[0].n,
      ),
      1,
      'Cash replay creates no second payment journal',
    );
    journal.finance_verification = {
      payment: cashRows[0],
      lines: cashLines,
      payment_journals: 1,
    };
    const final = await get(`${base}/reservations/${stay.reservationId}`);
    assert.equal(final.items[0].state, 'CHECKED_OUT');
    assert.equal(
      (
        await db.query(
          'SELECT housekeeping_state FROM resource WHERE id = $1',
          [room.id],
        )
      ).rows[0].housekeeping_state,
      'DIRTY',
    );
    await guard();
    journal.status = 'PASS_API_TRIAL';
    journal.finished_at = new Date().toISOString();
    save();
    console.log(
      JSON.stringify({
        status: journal.status,
        database,
        journal: journalPath,
        channels: 'NOT_TESTED',
      }),
    );
  }
} catch {
  journal.status = 'STOPPED';
  journal.failures ??= [];
  journal.failures.push({
    at: new Date().toISOString(),
    message: 'TRIAL_OPERATION_FAILED',
  });
  save();
  throwSafeTrialFailure();
} finally {
  if (harness) {
    await harness.closeSessions();
    await harness.closeBrowser();
  }
  await db.end();
}

function throwSafeTrialFailure() {
  throw new Error('TRIAL_OPERATION_FAILED');
}
