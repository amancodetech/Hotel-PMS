#!/usr/bin/env node
// Root-run reversible TEST-property app install only. Never a booking, configuration or purchase tool.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, open, rename, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const mode = process.argv[2];
assert.ok(['plan', 'apply', 'reconcile'].includes(mode));
const opts = {};
for (let i = 3; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith('--') && process.argv[i + 1]);
  opts[process.argv[i].slice(2)] = process.argv[i + 1];
}
const host = 'https://staging.channex.io';
const propertyId = 'e12fa48a-1939-4400-86fa-0b9575bf04e4';
const applicationId = 'ff989900-41da-4dd7-b40c-e29808eed5c6';
const body = {
  application_installation: {
    property_id: propertyId,
    application_code: 'booking_crs',
  },
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const out = resolve(opts.out);
assert.ok(out.startsWith(`${resolve('.local/verification')}/`));
await mkdir(out, { recursive: true, mode: 0o700 });
const info = await lstat(out);
assert.ok(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077));
async function atomic(name, value, exclusive = false) {
  const path = `${out}/${name}`,
    tmp = exclusive ? path : `${path}.${process.pid}.tmp`;
  const fd = await open(tmp, 'wx', 0o600);
  try {
    await fd.writeFile(json(value));
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (!exclusive) await rename(tmp, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
await atomic(
  mode === 'reconcile'
    ? `reconcile-${Date.now()}-${process.pid}.lock`
    : 'run.lock',
  { pid: process.pid, mode },
  true,
);
// Persistent lock: root checks that its PID stopped before clearing for a later invocation.
let calls = 0,
  postAttempted = false;
async function request(path, method = 'GET', payload) {
  if (mode === 'reconcile')
    assert.equal(method, 'GET', 'Reconciliation is GET-only');
  assert.ok(path.startsWith('/api/v1/'));
  const url = new URL(`${host}${path}`);
  assert.equal(url.origin, host);
  assert.equal(url.hash, '');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  const allowedGet = [
    '/api/v1/applications',
    '/api/v1/applications/installed',
    `/api/v1/properties/${propertyId}`,
    '/api/v1/availability',
    '/api/v1/restrictions',
  ];
  if (method === 'GET') assert.ok(allowedGet.includes(url.pathname));
  else {
    assert.equal(mode, 'apply');
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/api/v1/applications/install');
    assert.equal(url.search, '');
    assert.deepEqual(payload, body);
    assert.equal(postAttempted, false);
    postAttempted = true;
  }
  assert.ok(++calls <= 18, 'Request budget reached');
  const key = process.env.NP_CHANNEX_STAGING_KEY;
  assert.ok(key && !/[\r\n]/.test(key), 'Protected key environment required');
  const response = await fetch(url, {
    method,
    headers: {
      'user-api-key': key,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  const reader = response.body?.getReader();
  assert.ok(reader, 'Missing provider response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error('Provider response limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  assert.equal(response.status, 200, 'Provider operation unresolved');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function list(value) {
  assert.ok(Array.isArray(value.data));
  assert.ok(
    !value.links?.next && !value.meta?.next_page,
    'Pagination requires explicit review',
  );
  return value.data;
}
function metadata(data) {
  const found = list(data).filter(
    (row) => row.attributes?.code === 'booking_crs',
  );
  assert.equal(found.length, 1);
  const app = found[0].attributes;
  assert.equal(found[0].id, applicationId);
  assert.equal(app.id, applicationId);
  assert.equal(app.price, null);
  assert.equal(app.vr_price, null);
  assert.equal(app.is_configurable, true);
  assert.equal(app.representation_settings, null);
  // No inferred configuration, monthly charge or subscription consent from metadata.
  return {
    id: app.id,
    code: app.code,
    title: app.title,
    price: app.price,
    vr_price: app.vr_price,
    is_configurable: app.is_configurable,
    representation_settings: app.representation_settings,
  };
}
async function selectedState(scope) {
  const detail = await request(`/api/v1/properties/${propertyId}`);
  assert.equal(detail.data?.id, propertyId);
  assert.equal(detail.data?.attributes?.title, 'TEST new pratama / Villa 4');
  const count = detail.data?.attributes?.acc_channels_count;
  assert.equal(
    typeof count,
    'number',
    'Explicit channel count required; missing is not zero',
  );
  assert.equal(count, 0);
  const query = new URLSearchParams({
    'filter[property_id]': propertyId,
    'filter[date][gte]': '2026-10-15',
    'filter[date][lte]': '2026-10-15',
  });
  const availability = await request(`/api/v1/availability?${query}`);
  const restrictions = await request(
    `/api/v1/restrictions?${query}&filter[restrictions]=rate,stop_sell`,
  );
  const closed = {
    availability: availability.data?.[scope.room_id]?.['2026-10-15'],
    restrictions: restrictions.data?.[scope.rate_id]?.['2026-10-15'],
  };
  assert.equal(closed.availability, 0);
  assert.equal(closed.restrictions?.stop_sell, true);
  assert.equal(Number(closed.restrictions?.rate), 100000);
  return {
    property_id: propertyId,
    channel_count: 0,
    date: '2026-10-15',
    room_id: scope.room_id,
    rate_id: scope.rate_id,
    closed,
  };
}
async function bindings() {
  const paths = [
    'scripts/channex-staging-crs-install.mjs',
    '.local/verification/NP-channex-pms-20261011/applications-official.md',
    '.local/verification/NP-channex-pms-20261011/booking-crs-official.md',
    '.local/verification/NP-channex-pms-20261011/staging-public-index.js',
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, hash(await readFile(path))]),
    ),
  );
}
function installation(entries, reconcile = false) {
  assert.equal(
    entries.length,
    1,
    'Unexpected installations; inspect without mutations',
  );
  const row = entries[0],
    a = record(row.attributes);
  assert.equal(a.property_id, propertyId);
  assert.equal(a.application_code, 'booking_crs');
  assert.equal(a.application_id, applicationId);
  if (reconcile) {
    assert.equal(row.id, 'e2de77fc-d2ea-4657-a65b-6b901baefa56');
    assert.equal(
      Object.hasOwn(a, 'is_active'),
      false,
      'Unexpected active-status representation requires review',
    );
    assert.deepEqual(a.settings, {});
  } else assert.equal(a.is_active, true);
  assert.ok(typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id));
  assert.equal(a.id, row.id);
  assert.ok(
    a.settings === null ||
      (a.settings &&
        typeof a.settings === 'object' &&
        !Array.isArray(a.settings) &&
        Object.keys(a.settings).length === 0),
    'Unexpected configuration; inspect only',
  );
  return {
    installation_id: row.id,
    property_id: a.property_id,
    application_code: a.application_code,
    application_id: a.application_id,
    ...(reconcile
      ? { installed: true, active_status: 'UNVERIFIED' }
      : { is_active: a.is_active }),
    settings_empty: true,
  };
}
try {
  if (mode === 'plan') {
    const transportRaw = await readFile(opts['transport-plan']);
    assert.equal(hash(transportRaw), opts['transport-plan-sha256']);
    const transport = JSON.parse(transportRaw);
    assert.equal(transport.context.external_property_id, propertyId);
    assert.equal(transport.property_title, 'TEST new pratama / Villa 4');
    assert.equal(transport.room_pms_refs.resource_code, 'V04-R01');
    assert.equal(transport.scope.date_from, '2026-10-15');
    assert.equal(transport.scope.date_to, '2026-10-15');
    assert.equal(transport.scope.product_refs.length, 1);
    assert.equal(transport.scope.rate_refs.length, 1);
    const scope = {
      room_id: transport.scope.product_refs[0],
      rate_id: transport.scope.rate_refs[0],
    };
    const app = metadata(await request('/api/v1/applications'));
    const installed = list(await request('/api/v1/applications/installed'));
    assert.equal(
      installed.length,
      0,
      'Unknown existing installation state; no install',
    );
    const state = await selectedState(scope);
    const plan = {
      mode: 'SELECTED_REVERSIBLE_STAGING_APP_INSTALL_ONLY',
      body,
      body_sha256: hash(json(body)),
      property_id: propertyId,
      application_metadata: app,
      existing_installations: [],
      selected_state: state,
      transport_plan_sha256: hash(transportRaw),
      source_hashes: await bindings(),
      cost_observation: 'NO_MONTHLY_FEE_DISPLAYED_WHEN_BOTH_PRICE_FIELDS_NULL',
      free_or_future_billing_guaranteed: false,
      additional_configuration_authorized: false,
      purchase_authorized: false,
      booking_creation_authorized_by_this_script: false,
      created_at: new Date().toISOString(),
    };
    await atomic('plan.json', plan, true);
    console.log(
      json({
        status: 'READ_ONLY_CRS_INSTALL_PLAN_READY',
        plan_sha256: hash(json(plan)),
        body_sha256: plan.body_sha256,
        free_or_future_billing_guaranteed: false,
      }),
    );
  } else {
    const raw = await readFile(`${out}/plan.json`);
    assert.equal(hash(raw), opts['approve-plan-sha256']);
    const plan = JSON.parse(raw);
    assert.deepEqual(plan.body, body);
    const currentBindings = await bindings();
    if (mode === 'reconcile') {
      assert.equal(
        hash(raw),
        '07be1bb35fa3ec759b5fd329ed801cbb285cb2dc5685a5016b02bfbdfd368757',
      );
      assert.equal(
        plan.source_hashes['scripts/channex-staging-crs-install.mjs'],
        '943a81df5f5a265d3300b875be1a88cf749ee4f609f877f5282b0789b2543000',
      );
      assert.deepEqual(plan.source_hashes, {
        ...currentBindings,
        'scripts/channex-staging-crs-install.mjs':
          '943a81df5f5a265d3300b875be1a88cf749ee4f609f877f5282b0789b2543000',
      });
      assert.equal(plan.body_sha256, hash(json(body)));
      assert.equal(plan.property_id, propertyId);
      assert.equal(plan.mode, 'SELECTED_REVERSIBLE_STAGING_APP_INSTALL_ONLY');
      assert.deepEqual(plan.existing_installations, []);
      assert.equal(
        plan.selected_state.room_id,
        '4d36bfe6-8dae-4a7b-93d0-b66859d9877a',
      );
      assert.equal(
        plan.selected_state.rate_id,
        '36cb82ac-cd2b-4a34-b369-9b1807a31cc7',
      );
    } else assert.deepEqual(plan.source_hashes, currentBindings);
    assert.deepEqual(
      metadata(await request('/api/v1/applications')),
      plan.application_metadata,
    );
    const installed = list(await request('/api/v1/applications/installed'));
    let journal;
    try {
      journal = JSON.parse(await readFile(`${out}/journal.json`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (mode === 'reconcile')
      assert.ok(journal, 'Prior immutable INTENT required');
    if (journal) {
      assert.equal(journal.plan_sha256, hash(raw));
      assert.equal(journal.body_sha256, hash(json(body)));
      assert.equal(journal.state, 'INTENT');
      assert.equal(journal.post_path, '/api/v1/applications/install');
      assert.equal(journal.property_id, propertyId);
      assert.ok(
        typeof journal.intent_at === 'string' &&
          Number.isFinite(Date.parse(journal.intent_at)),
      );
      assert.deepEqual(
        Object.keys(journal).sort(),
        [
          'plan_sha256',
          'body_sha256',
          'state',
          'intent_at',
          'post_path',
          'property_id',
        ].sort(),
      );
      const observed = installation(installed, mode === 'reconcile');
      const state = await selectedState(plan.selected_state);
      await atomic(
        `reconciled-${Date.now()}.json`,
        {
          status: 'CRS_INSTALL_RECONCILED_READ_ONLY',
          ...observed,
          selected_state: state,
          original_journal_preserved: true,
          original_lock_and_failure_preserved: true,
          reviewed_plan_sha256: hash(raw),
          current_source_sha256:
            currentBindings['scripts/channex-staging-crs-install.mjs'],
          requests: calls,
          post_attempted: postAttempted,
          completed_at: new Date().toISOString(),
          booking_lifecycle: 'NOT_TESTED',
          free_or_future_billing_guaranteed: false,
          g13_accepted: false,
        },
        true,
      );
      console.log(
        json({ status: 'CRS_INSTALL_RECONCILED_READ_ONLY', ...observed }),
      );
    } else {
      assert.equal(installed.length, 0, 'Unknown installation state; no POST');
      await selectedState(plan.selected_state);
      journal = {
        plan_sha256: hash(raw),
        body_sha256: hash(json(body)),
        state: 'INTENT',
        intent_at: new Date().toISOString(),
        post_path: '/api/v1/applications/install',
        property_id: propertyId,
      };
      await atomic('journal.json', journal, true);
      const result = await request(
        '/api/v1/applications/install',
        'POST',
        body,
      );
      const accepted = installation([result.data]);
      const observed = installation(
        list(await request('/api/v1/applications/installed')),
      );
      assert.deepEqual(observed, accepted);
      const state = await selectedState(plan.selected_state);
      await atomic(
        'receipt.json',
        {
          status: 'SELECTED_CRS_APP_INSTALLED_WITH_LIMITS',
          ...observed,
          selected_state: state,
          requests: calls,
          completed_at: new Date().toISOString(),
          booking_lifecycle: 'NOT_TESTED',
          configuration_changed: false,
          purchase_submitted: false,
          free_or_future_billing_guaranteed: false,
          g13_accepted: false,
        },
        true,
      );
      // INTENT is immutable; receipt supplies observed completion rather than rewriting an uncertain journal.
      console.log(
        json({
          status: 'SELECTED_CRS_APP_INSTALLED_WITH_LIMITS',
          ...observed,
          booking_lifecycle: 'NOT_TESTED',
        }),
      );
    }
  }
} catch {
  await atomic(
    `failure-${mode}-${Date.now()}.json`,
    {
      status: 'STOPPED_NO_AUTOMATIC_RETRY',
      mode,
      requests: calls,
      post_attempted: postAttempted,
      at: new Date().toISOString(),
    },
    true,
  );
  console.error(
    'CRS_INSTALL_STOPPED: inspect private plan/INTENT; unknown install is never blindly retried',
  );
  process.exitCode = 1;
}
