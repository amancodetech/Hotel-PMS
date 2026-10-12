#!/usr/bin/env node
// Root-run, closed staging catalog only. Never imports application runtime or DB.
import { readFile, mkdir, open, rename, stat, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const HOST = 'https://staging.channex.io';
const SOURCE =
  '.local/verification/new-pratama-location-completion-20261009/data-hotel.json';
const PREFIX = 'TEST new pratama';
const GROUP = `${PREFIX} / shared physical inventory`;
const NOTICE =
  'TEST ONLY. Shared physical inventory: whole villas and constituent rooms overlap; never 97 independent units. Availability 0; no channel connections. Not a final OTA/listing/billing model.';
const args = process.argv.slice(2);
const mode = args.shift();
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1])
    throw new Error('Expected --option value');
  opts[args[i].slice(2)] = args[i + 1];
}
const fail = (message) => {
  throw new Error(message);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const attr = (entity) => entity.attributes ?? {};
const rel = (entity, name) =>
  entity.relationships?.[name]?.data?.id ?? attr(entity)[`${name}_id`];

async function atomic(path, value, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(json(value));
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(json(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function api(path, body) {
  const url = new URL(`/api/v1/${path}`, HOST);
  if (
    url.origin !== HOST ||
    !/^\/api\/v1\/(groups|properties|room_types|rate_plans|availability|restrictions)(\/|\?|$)/.test(
      url.pathname + url.search,
    )
  )
    fail('Endpoint outside catalog allowlist');
  const key =
    process.env.CHANNEX_STAGING_API_KEY ?? process.env.CHANNEX_API_KEY;
  if (!key || /[\r\n]/.test(key)) fail('Missing scoped staging credential');
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        'user-api-key': key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    fail(
      'Transport outcome unknown; reconcile journal before any further mutation',
    );
  }
  // Bound untrusted response bytes, including errors, without saving raw account content.
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) fail(`Channex HTTP ${response.status}; empty response`);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('Provider response exceeds 2MB bound; reconcile any mutation');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(
      `Channex HTTP ${response.status}; invalid JSON outcome; reconcile journal`,
    );
  }
  if (!response.ok) {
    // Only known non-sensitive schema-field names and fixed validation phrases survive.
    // Never print provider title/message, supplied values, contact fields, or arbitrary text.
    const fields = new Set([
      'title',
      'currency',
      'timezone',
      'property_type',
      'group_id',
      'property_id',
      'room_type_id',
      'count_of_rooms',
      'occ_adults',
      'occ_children',
      'occ_infants',
      'default_occupancy',
      'room_kind',
      'capacity',
      'options',
      'occupancy',
      'rate',
      'sell_mode',
      'rate_mode',
      'stop_sell',
      'state_length',
      'date',
      'date_from',
      'date_to',
      'availability',
      'settings',
      'content',
    ]);
    const phrases = new Set([
      "can't be blank",
      'is invalid',
      'is required',
      'has already been taken',
      'must be greater than 0',
      'must be greater than or equal to 0',
      'must be less than or equal to 18',
      'is not included in the list',
    ]);
    const errors = result?.errors;
    const knownCodes = new Set([
      'unauthorized',
      'validation_error',
      'resource_not_found',
      'bad_request',
      'forbidden',
      'too_many_requests',
      'internal_server_error',
    ]);
    const safeCode = knownCodes.has(errors?.code)
      ? errors.code
      : 'unclassified';
    const details = Object.fromEntries(
      Object.entries(errors?.details ?? {})
        .filter(([field]) => fields.has(field))
        .map(([field, values]) => [
          field,
          Array.isArray(values)
            ? values
                .slice(0, 10)
                .map((value) =>
                  phrases.has(value)
                    ? value
                    : 'PROVIDER_VALIDATION_DETAIL_REDACTED',
                )
            : ['PROVIDER_VALIDATION_DETAIL_REDACTED'],
        ]),
    );
    const safe = {
      endpoint: url.pathname,
      http_status: response.status,
      error_code: safeCode,
      validation_fields: details,
    };
    const errorOut = resolve(opts.out ?? '.local/verification');
    if (errorOut.startsWith(`${resolve('.local/verification')}/`))
      await atomic(`${errorOut}/provider-error-${Date.now()}.json`, safe, true);
    fail(
      `Channex HTTP ${response.status}; ${safeCode}; validation fields=${Object.keys(details).join(',') || 'redacted'}; no automatic retry`,
    );
  }
  if (result.meta?.warnings?.length)
    fail('Provider warnings require review; journal remains pending');
  return result;
}

async function list(kind, propertyId) {
  const results = [];
  const MAX_LIST_PAGES = propertyId ? 2 : 5;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[limit]': '100',
    });
    if (propertyId) query.set('filter[property_id]', propertyId);
    const result = await api(`${kind}?${query}`);
    if (
      !Array.isArray(result.data) ||
      !Number.isInteger(result.meta?.total) ||
      !Number.isInteger(result.meta?.limit)
    )
      fail(`Unrecognized ${kind} pagination; fail closed`);
    results.push(...result.data);
    if (results.length >= result.meta.total) return results;
    if (!result.data.length) fail('Incomplete pagination');
  }
  fail(
    `Pagination exceeded ${MAX_LIST_PAGES}-request bound; inspect account scope before proceeding`,
  );
}

async function baseline(path, start) {
  const raw = await readFile(path);
  const data = JSON.parse(raw);
  const rows = data.rows;
  const pms = rows?.property?.[0];
  if (
    data.status !== 'PASS_READ_ONLY_DB_INVARIANTS' ||
    rows.property.length !== 1 ||
    pms.name !== 'new pratama' ||
    pms.timezone !== 'Asia/Jakarta' ||
    pms.base_currency !== 'IDR'
  )
    fail('Unexpected baseline');
  const resources = rows.resource;
  if (
    resources.length !== 97 ||
    resources.filter((r) => r.resource_type === 'ROOM').length !== 73 ||
    resources.filter((r) => r.resource_type === 'VILLA').length !== 24
  )
    fail('Unexpected inventory counts');
  for (const key of [
    'resource',
    'product',
    'location',
    'product_resource_candidate',
    'composition_version',
    'composition_leaf',
  ]) {
    if (
      !Array.isArray(rows[key]) ||
      rows[key].some(
        (row) => row.tenant_id !== pms.tenant_id || row.property_id !== pms.id,
      )
    )
      fail('Baseline scope mismatch');
  }
  const locations = new Map(rows.location.map((l) => [l.id, l]));
  const products = new Map(rows.product.map((p) => [p.id, p]));
  const candidates = new Map(
    rows.product_resource_candidate.map((c) => [c.resource_id, c.product_id]),
  );
  function locationPath(id, seen = new Set()) {
    if (!id || seen.has(id) || !locations.has(id))
      fail('Missing/cyclic location');
    seen.add(id);
    const l = locations.get(id);
    return [
      ...(l.parent_id ? locationPath(l.parent_id, seen) : []),
      { id: l.id, code: l.code, name: l.name, kind: l.kind },
    ];
  }
  const natural = (a, b) =>
    a.code.localeCompare(b.code, 'en', { numeric: true });
  const properties = [];
  const villas = resources
    .filter((r) => r.resource_type === 'VILLA')
    .sort(natural);
  const day = new Date(`${start}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    Number.isNaN(day.valueOf()) ||
    day.toISOString().slice(0, 10) !== start
  )
    fail('Invalid --start');
  const end = new Date(day.valueOf() + 99 * 86400000)
    .toISOString()
    .slice(0, 10);
  function room(resource, product, leaves, composition) {
    if (!product || product.name !== resource.display_label)
      fail('Resource/product name mismatch');
    if (
      !Number.isInteger(product.occupancy_adults_max) ||
      product.occupancy_adults_max <= 0 ||
      !Number.isInteger(product.occupancy_children_max)
    )
      fail('Missing capacity');
    const pmsRef = {
      tenant_id: pms.tenant_id,
      property_id: pms.id,
      resource_id: resource.id,
      product_id: product.id,
      resource_code: resource.code,
      name: product.name,
      location_path: locationPath(resource.location_id),
      composition_id: composition?.id ?? null,
      physical_leaf_resource_ids: leaves,
      pms_max_adults: product.occupancy_adults_max,
      pms_max_children: product.occupancy_children_max,
      pms_capacity: resource.capacity,
    };
    const description = `${NOTICE}\nPMS reference: ${JSON.stringify(pmsRef)}\nChild policy is an allowance, not evidence of child-only beds; Channex child-only beds and infant cots=0. Child-capacity fidelity unresolved; do not open sale.`;
    return {
      key: resource.id,
      pms: pmsRef,
      payload: {
        title: product.name,
        count_of_rooms: 1,
        occ_adults: product.occupancy_adults_max,
        occ_children: 0,
        occ_infants: 0,
        default_occupancy: product.occupancy_adults_max,
        room_kind: 'room',
        content: { description },
      },
      rate: {
        title: `TEST CLOSED / ${resource.code}`,
        currency: 'IDR',
        sell_mode: 'per_room',
        rate_mode: 'manual',
        stop_sell: Array(7).fill(true),
        options: [
          {
            occupancy: product.occupancy_adults_max,
            is_primary: true,
            rate: '100000.00',
          },
        ],
      },
    };
  }
  for (const villa of villas) {
    const children = resources
      .filter((r) => r.parent_resource_id === villa.id)
      .sort(natural);
    const product = rows.product.find(
      (p) => p.name === villa.display_label && p.kind === 'VILLA',
    );
    const current = rows.composition_version.filter(
      (c) =>
        c.product_id === product?.id &&
        c.status === 'ACTIVE' &&
        c.effective_from <= `${start}T00:00:00.000Z` &&
        c.effective_to > `${end}T00:00:00.000Z`,
    );
    if (!product || current.length !== 1 || !children.length)
      fail('Missing unique current villa composition');
    const leaves = rows.composition_leaf
      .filter((l) => l.version_id === current[0].id)
      .map((l) => l.resource_id)
      .sort();
    if (!equal(leaves, children.map((c) => c.id).sort()))
      fail('Composition does not match actual villa rooms');
    const rooms = [
      room(villa, product, leaves, current[0]),
      ...children.map((r) =>
        room(r, products.get(candidates.get(r.id)), [r.id]),
      ),
    ];
    properties.push({
      key: villa.id,
      payload: {
        title: `${PREFIX} / ${villa.display_label}`,
        currency: 'IDR',
        timezone: 'Asia/Jakarta',
        property_type: 'hotel',
        settings: {
          state_length: 100,
          allow_availability_autoupdate_on_modification: false,
          allow_availability_autoupdate_on_cancellation: false,
        },
        content: {
          description: `${NOTICE}\nPMS villa resource ${villa.id}; location ${JSON.stringify(locationPath(villa.location_id))}`,
        },
      },
      rooms,
    });
  }
  const independent = resources
    .filter((r) => r.resource_type === 'ROOM' && !r.parent_resource_id)
    .sort(natural);
  if (independent.length !== 6) fail('Unexpected independent rooms');
  properties.push({
    key: 'KL',
    payload: {
      title: `${PREFIX} / Kamar Lepas 1..6`,
      currency: 'IDR',
      timezone: 'Asia/Jakarta',
      property_type: 'hotel',
      settings: {
        state_length: 100,
        allow_availability_autoupdate_on_modification: false,
        allow_availability_autoupdate_on_cancellation: false,
      },
      content: {
        description: `${NOTICE}\nSix independent KL rooms; location encoded on each room type.`,
      },
    },
    rooms: independent.map((r) =>
      room(r, products.get(candidates.get(r.id)), [r.id]),
    ),
  });
  if (
    properties.some((p) => p.rooms.length > 20) ||
    properties.flatMap((p) => p.rooms).length !== 97
  )
    fail('Catalog exceeds standard limits or incorrect count');
  return {
    schema: 1,
    host: HOST,
    source_path: resolve(path),
    source_sha256: hash(raw),
    group_title: GROUP,
    inventory_notice: NOTICE,
    capacity_gap:
      'Child allowances do not prove child-only beds; no independent child beds or infant cots invented. Capacity mapping is closed-test only.',
    date_from: start,
    date_to: end,
    dummy_rate_idr: '100000.00',
    physical_room_atoms: 73,
    villa_containers: 24,
    independent_sellable_units_claimed: false,
    properties,
  };
}

function assertPayload(entity, payload, relationship = {}) {
  const actual = attr(entity);
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'content') {
      if (actual.content?.description !== value.description)
        fail('Catalog description/ownership mismatch');
    } else if (key === 'settings') {
      for (const [setting, expected] of Object.entries(value))
        if (actual.settings?.[setting] !== expected)
          fail(`Property setting mismatch: ${setting}`);
    } else if (key === 'options') {
      if (
        !Array.isArray(actual.options) ||
        actual.options.length !== 1 ||
        actual.options[0].occupancy !== value[0].occupancy ||
        actual.options[0].is_primary !== true ||
        Number(actual.options[0].rate) !== Number(value[0].rate)
      )
        fail('Rate occupancy/price mismatch');
    } else if (!equal(actual[key], value))
      fail(`Catalog field mismatch: ${key}`);
  }
  for (const [key, value] of Object.entries(relationship))
    if (rel(entity, key) !== value)
      fail(`Catalog relationship mismatch: ${key}`);
  if (!uuid(entity.id)) fail('Invalid external ID');
}

async function lookup(kind, title, propertyId) {
  const found = (await list(kind, propertyId)).filter(
    (e) => attr(e).title === title,
  );
  if (found.length > 1) fail(`Ambiguous exact title in ${kind}`);
  if (!found.length) return null;
  const full = (await api(`${kind}/${found[0].id}`)).data;
  if (!full || full.id !== found[0].id) fail('Get/list ID mismatch');
  return full;
}

function limits(entity, planned) {
  const a = attr(entity);
  if (a.acc_channels_count !== 0)
    fail('Property has channel connections; stop');
  if (
    a.max_count_of_room_types < planned.rooms.length ||
    a.max_count_of_rate_plans < planned.rooms.length ||
    !Number.isInteger(a.max_count_of_room_types) ||
    !Number.isInteger(a.max_count_of_rate_plans) ||
    !Number.isInteger(a.max_count_of_occupancies) ||
    a.max_count_of_occupancies < 1
  )
    fail('Actual property limits missing/insufficient; never raise caps');
}

async function inspect(plan) {
  const group = await lookup('groups', plan.group_title);
  const found = [];
  for (const p of plan.properties) {
    const entity = await lookup('properties', p.payload.title);
    if (!entity) {
      found.push({ key: p.key, exists: false });
      continue;
    }
    assertPayload(entity, p.payload);
    limits(entity, p);
    if (
      !group ||
      !entity.relationships?.groups?.data?.some((g) => g.id === group.id)
    )
      fail('Existing property outside exact test group');
    const rooms = await list('room_types', entity.id);
    const rates = await list('rate_plans', entity.id);
    if (
      rooms.some(
        (r) =>
          !p.rooms.some((expected) => expected.payload.title === attr(r).title),
      ) ||
      rates.some(
        (r) =>
          !p.rooms.some((expected) => expected.rate.title === attr(r).title),
      )
    )
      fail('Unexpected catalog entity in test property');
    for (const expected of p.rooms) {
      const matchedRooms = rooms.filter(
        (r) => attr(r).title === expected.payload.title,
      );
      const matchedRates = rates.filter(
        (r) => attr(r).title === expected.rate.title,
      );
      if (matchedRooms.length > 1 || matchedRates.length > 1)
        fail('Duplicate exact room/rate title');
      if (matchedRooms.length) {
        const full = (await api(`room_types/${matchedRooms[0].id}`)).data;
        assertPayload(full, expected.payload, { property: entity.id });
      }
      if (matchedRates.length) {
        if (!matchedRooms.length) fail('Rate exists without expected room');
        const full = (await api(`rate_plans/${matchedRates[0].id}`)).data;
        assertPayload(full, expected.rate, {
          property: entity.id,
          room_type: matchedRooms[0].id,
        });
      }
    }
    found.push({
      key: p.key,
      exists: true,
      id: entity.id,
      room_types: rooms.map((r) => ({ id: r.id, title: attr(r).title })),
      rate_plans: rates.map((r) => ({ id: r.id, title: attr(r).title })),
      limits: {
        room_types: attr(entity).max_count_of_room_types,
        rate_plans: attr(entity).max_count_of_rate_plans,
        occupancies: attr(entity).max_count_of_occupancies,
      },
    });
  }
  return { group_id: group?.id ?? null, properties: found };
}

async function main() {
  if (!['plan', 'apply', 'check'].includes(mode))
    fail(
      'Usage: plan|apply|check --out private-directory [--source path --start YYYY-MM-DD] [--plan plan.json --approve-plan-sha256 digest]',
    );
  const out = resolve(opts.out ?? fail('--out is required'));
  if (!out.startsWith(`${resolve('.local/verification')}/`))
    fail('--out must be inside .local/verification');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const info = await lstat(out);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    fail('Evidence directory must be private mode0700');
  if (mode === 'plan') {
    const plan = await baseline(
      opts.source ?? SOURCE,
      opts.start ?? fail('--start required'),
    );
    plan.observed = await inspect(plan);
    await atomic(`${out}/plan.json`, plan, true);
    const digest = hash(json(plan));
    await atomic(
      `${out}/plan-review.json`,
      {
        plan_sha256: digest,
        property_count: 25,
        room_type_count: 97,
        rate_plan_count: 97,
        physical_room_atoms: 73,
        closed_only: true,
        no_channel_connections: true,
        capacity_gap: plan.capacity_gap,
      },
      true,
    );
    console.log(
      json({
        status: 'READ_ONLY_PLAN_READY',
        plan_sha256: digest,
        plan_path: `${out}/plan.json`,
      }).trim(),
    );
    return;
  }
  const planRaw = await readFile(resolve(opts.plan ?? `${out}/plan.json`));
  const plan = JSON.parse(planRaw);
  const canonical = await baseline(plan.source_path, plan.date_from);
  const expected = { ...plan };
  delete expected.observed;
  if (!equal(canonical, expected) || plan.host !== HOST)
    fail('Source/plan changed; generate a fresh reviewed plan');
  const digest = hash(planRaw);
  if (mode === 'apply' && opts['approve-plan-sha256'] !== digest)
    fail('Root must review concrete plan and pass its exact SHA256');
  await inspect(plan);
  const journalPath = `${out}/journal.json`;
  let journal;
  try {
    const s = await stat(journalPath);
    if (s.mode & 0o077) fail('Journal is not private');
    journal = JSON.parse(await readFile(journalPath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    journal = { schema: 1, plan_sha256: digest, operations: {} };
  }
  if (journal.plan_sha256 !== digest) fail('Journal plan mismatch');
  const lock = await open(`${out}/run.lock`, 'wx', 0o600).catch(() =>
    fail(
      'Run lock exists; root must confirm no live process and preserve/reconcile before clearing lock',
    ),
  );
  // Persistent lock intentionally survives exit/crash; prevents accidental concurrent/repeated writes.
  await lock.writeFile(json({ pid: process.pid, mode, plan_sha256: digest }));
  await lock.sync();
  await lock.close();
  async function save() {
    await atomic(journalPath, journal);
  }
  async function ensure(kind, key, payload, propertyId, relationship = {}) {
    const operation = `${kind}:${key}`;
    const entry = journal.operations[operation];
    const entity = await lookup(kind, payload.title, propertyId);
    if (entity) {
      assertPayload(entity, payload, relationship);
      if (entry?.id && entry.id !== entity.id)
        fail('Journal/external ID mismatch');
      journal.operations[operation] = {
        state: 'RECONCILED',
        id: entity.id,
        title: payload.title,
      };
      await save();
      return entity;
    }
    if (entry)
      fail(
        'Prior intent/entity absent; uncertain mutation cannot be retried blindly',
      );
    if (mode !== 'apply')
      fail('Catalog incomplete; check never creates missing entities');
    journal.operations[operation] = {
      state: 'INTENT',
      title: payload.title,
      payload_sha256: hash(JSON.stringify(payload)),
      at: new Date().toISOString(),
    };
    await save();
    const singular = {
      groups: 'group',
      properties: 'property',
      room_types: 'room_type',
      rate_plans: 'rate_plan',
    }[kind];
    const created = (
      await api(kind, {
        [singular]: {
          ...payload,
          ...(propertyId ? { property_id: propertyId } : {}),
          ...(relationship.room_type
            ? { room_type_id: relationship.room_type }
            : {}),
        },
      })
    ).data;
    if (!created || !uuid(created.id))
      fail('Create outcome unknown; reconcile exact title');
    journal.operations[operation].id = created.id;
    await save();
    const fetched = (await api(`${kind}/${created.id}`)).data;
    assertPayload(fetched, payload, relationship);
    journal.operations[operation] = {
      state: 'CONFIRMED',
      id: created.id,
      title: payload.title,
    };
    await save();
    return fetched;
  }
  const group = await ensure('groups', 'group', { title: GROUP });
  let verifiedRooms = 0;
  for (const p of plan.properties) {
    // group_id is create-only; response membership is checked separately.
    let entity = await lookup('properties', p.payload.title);
    if (!entity) {
      const operation = `properties:${p.key}`;
      if (journal.operations[operation])
        fail('Unresolved property creation; reconciliation required');
      if (mode !== 'apply') fail('Missing property');
      journal.operations[operation] = {
        state: 'INTENT',
        title: p.payload.title,
        at: new Date().toISOString(),
      };
      await save();
      const result = (
        await api('properties', {
          property: { ...p.payload, group_id: group.id },
        })
      ).data;
      if (!result || !uuid(result.id)) fail('Unknown property create result');
      journal.operations[operation].id = result.id;
      await save();
      entity = (await api(`properties/${result.id}`)).data;
    }
    assertPayload(entity, p.payload);
    limits(entity, p);
    if (!entity.relationships?.groups?.data?.some((g) => g.id === group.id))
      fail('Test group membership mismatch');
    const previous = journal.operations[`properties:${p.key}`];
    if (previous?.id && previous.id !== entity.id) fail('Property ID mismatch');
    journal.operations[`properties:${p.key}`] = {
      state: 'RECONCILED',
      id: entity.id,
      title: p.payload.title,
    };
    await save();
    const roomIds = [],
      rateIds = [];
    for (const r of p.rooms) {
      const room = await ensure('room_types', r.key, r.payload, entity.id, {
        property: entity.id,
      });
      const rate = await ensure('rate_plans', r.key, r.rate, entity.id, {
        property: entity.id,
        room_type: room.id,
      });
      roomIds.push(room.id);
      rateIds.push(rate.id);
    }
    const query = new URLSearchParams({
      'filter[property_id]': entity.id,
      'filter[date][gte]': plan.date_from,
      'filter[date][lte]': plan.date_to,
    });
    async function verifyClosed() {
      const availability = (await api(`availability?${query}`)).data;
      const restrictions = (
        await api(`restrictions?${query}&filter[restrictions]=stop_sell,rate`)
      ).data;
      for (let n = 0; n < 100; n++) {
        const date = new Date(
          new Date(`${plan.date_from}T00:00:00Z`).valueOf() + n * 86400000,
        )
          .toISOString()
          .slice(0, 10);
        for (const id of roomIds)
          if (availability?.[id]?.[date] !== 0) return false;
        for (const id of rateIds)
          if (
            restrictions?.[id]?.[date]?.stop_sell !== true ||
            Number(restrictions?.[id]?.[date]?.rate) !==
              Number(plan.dummy_rate_idr)
          )
            return false;
      }
      return true;
    }
    const operation = `closed-ari:${p.key}`;
    const alreadyClosed = await verifyClosed();
    if (!alreadyClosed) {
      if (journal.operations[operation])
        fail(
          'Pending ARI not verified; stop for read-only reconciliation, no blind resend',
        );
      if (mode !== 'apply') fail('ARI closure not fully verified');
      journal.operations[operation] = {
        state: 'INTENT',
        property_id: entity.id,
        at: new Date().toISOString(),
      };
      await save();
      await api('availability', {
        values: roomIds.map((id) => ({
          property_id: entity.id,
          room_type_id: id,
          date_from: plan.date_from,
          date_to: plan.date_to,
          availability: 0,
        })),
      });
      await api('restrictions', {
        values: rateIds.map((id) => ({
          property_id: entity.id,
          rate_plan_id: id,
          date_from: plan.date_from,
          date_to: plan.date_to,
          stop_sell: true,
          rate: plan.dummy_rate_idr,
        })),
      });
      if (!(await verifyClosed()))
        fail(
          'ARI asynchronous/not verified; run check after root reconciliation, no blind resend',
        );
    }
    journal.operations[operation] = {
      state: 'VERIFIED_GET',
      property_id: entity.id,
      date_from: plan.date_from,
      date_to: plan.date_to,
    };
    await save();
    verifiedRooms += roomIds.length;
  }
  await inspect(plan);
  const receipt = {
    status: 'STAGING_CLOSED_CATALOG_VERIFIED',
    host: HOST,
    plan_sha256: digest,
    property_count: 25,
    room_type_count: verifiedRooms,
    rate_plan_count: verifiedRooms,
    physical_room_atoms: 73,
    independent_97_units: false,
    availability: 0,
    stop_sell: true,
    date_from: plan.date_from,
    date_to: plan.date_to,
    g13_accepted: false,
    channels_connected: false,
    pms_runtime_connection_proven: false,
    child_capacity_fidelity: 'UNRESOLVED_CLOSED_TEST_ONLY',
    checked_at: new Date().toISOString(),
  };
  await atomic(`${out}/${mode}-receipt.json`, receipt);
  console.log(json(receipt).trim());
}
main().catch((error) => {
  console.error(`CATALOG_STOP: ${error.message}`);
  process.exitCode = 1;
});
