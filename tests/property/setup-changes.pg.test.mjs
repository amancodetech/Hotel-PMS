import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  assertNotBackdated,
  businessToday,
  setClockForTests,
} from '../../packages/backend/dist/index.js';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let admin;
let auditor;

const runId = Date.now().toString(36);
const key = (name) => `set06-${runId}-${name}`;

const baseDraft = (overrides = {}) => ({
  property: {
    name: 'SET-06 Property',
    code: `SET06-${runId.toUpperCase()}`,
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  unit_groups: [
    {
      template_code: 'ROOM',
      pattern: '101-102',
      exclusions: [],
      capacity: 2,
      rental_mode: 'EXCLUSIVE',
    },
  ],
  operations: {
    check_in: '14:00',
    check_out: '12:00',
    inspection_required: false,
    explicit_states: true,
  },
  pricing: { postponed: true },
  ...overrides,
});

function addDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProperty(code, name) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    { body: { code, name, timezone: 'Asia/Jakarta' } },
  );
  expect(created.status).toBe(201);
  return created.body.property;
}

async function getDraft(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
  );
  expect(response.status).toBe(200);
  return response.body.draft;
}

async function saveDraft(target, body, name, ifMatch = undefined) {
  const headers = { 'idempotency-key': key(name) };
  if (ifMatch !== undefined) headers['if-match'] = ifMatch;
  const response = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    { body, headers },
  );
  expect(response.status).toBe(200);
  return response.body.draft;
}

async function preview(target) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/preview`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function apply(target, previewVersion, name, revision) {
  const draft = await getDraft(target);
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/apply`,
    {
      body: { preview_version: previewVersion },
      headers: {
        'idempotency-key': key(name),
        'if-match': `"${draft.draft_id}:${revision}"`,
      },
    },
  );
}

async function applyDraft(target, body, name) {
  const draft = await saveDraft(target, body, `${name}-save`);
  const ready = await preview(target);
  expect(ready.blockers).toEqual([]);
  const applied = await apply(
    target,
    ready.preview_version,
    `${name}-apply`,
    draft.revision,
  );
  expect(applied.status).toBe(200);
  return applied.body.result;
}

async function resources(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/resources?limit=100`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function products(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/products`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function compositions(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/compositions`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function compositionDetail(target, compositionId) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/compositions/${compositionId}`,
  );
  return response;
}

async function inventoryVersion(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function hold(target, productId, name, options = {}) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: productId,
            period: {
              arrival: options.arrival ?? addDays(10),
              departure: options.departure ?? addDays(12),
            },
            occupancy: { adults: options.adults ?? 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version:
          options.version !== undefined
            ? options.version
            : await inventoryVersion(target),
        ttl_seconds: 300,
      },
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function releaseHold(target, holdId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/holds/${holdId}/release`,
  );
  expect(response.status).toBe(200);
}

async function settings(target) {
  return apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-settings`,
  );
}

async function changes(target, query = '') {
  return apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-changes${query}`,
  );
}

async function reconciliation(target) {
  return apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-reconciliation`,
  );
}

async function previewChange(target, compositionId, body, context = admin) {
  return apiRequest(
    context.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/compositions/${compositionId}/change-previews`,
    { body },
  );
}

let applySequence = 0;

const applyKey = (name) => `set06-${runId}-${name}-${(applySequence += 1)}`;

function applyHeaders(options) {
  if (options.idempotencyKey === null) return {};
  return {
    'idempotency-key':
      options.idempotencyKey ?? applyKey(options.name ?? 'apply'),
  };
}

async function applyChange(
  target,
  compositionId,
  body,
  context = admin,
  options = {},
) {
  return apiRequest(
    context.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/compositions/${compositionId}/changes`,
    { body, headers: applyHeaders(options) },
  );
}

async function previewMigration(target, body, context = admin) {
  return apiRequest(
    context.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-migration-previews`,
    { body },
  );
}

async function applyMigration(target, body, context = admin, options = {}) {
  return apiRequest(
    context.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-migrations`,
    { body, headers: applyHeaders(options) },
  );
}

const villaPartsDraft = (property, overrides = {}) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['VILLA'],
    },
    unit_groups: [
      {
        template_code: 'VILLA',
        pattern: '1-2',
        capacity: 4,
        rental_mode: 'WHOLE_OR_PARTS',
        privacy_ack: true,
        parts: [
          { label: 'A', capacity: 2 },
          { label: 'B', capacity: 2 },
        ],
        ...overrides,
      },
    ],
  });

const singleVillaDraft = (property) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['VILLA'],
    },
    unit_groups: [
      {
        template_code: 'VILLA',
        pattern: '1-1',
        capacity: 6,
        rental_mode: 'WHOLE_OR_PARTS',
        privacy_ack: true,
        parts: [
          { label: 'A', capacity: 2 },
          { label: 'B', capacity: 2 },
          { label: 'C', capacity: 2 },
        ],
      },
    ],
  });

const roomsDraft = (property) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['ROOM'],
    },
    unit_groups: [
      {
        template_code: 'ROOM',
        pattern: '201-202',
        exclusions: [],
        capacity: 2,
        rental_mode: 'EXCLUSIVE',
      },
    ],
  });

async function wholeComposition(property, productCode) {
  const items = await products(property);
  const product = items.find((row) => row.code === productCode);
  const versions = await compositions(property);
  const composition = versions.find((row) => row.product_id === product.id);
  return { product, composition };
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('settings and change log are property scoped and read only', async () => {
  const first = await createProperty(`SET06-S1-${runId}`, 'SET-06 settings A');
  const second = await createProperty(`SET06-S2-${runId}`, 'SET-06 settings B');
  await applyDraft(first, villaPartsDraft(first), 'settings-a');
  await applyDraft(second, roomsDraft(second), 'settings-b');
  const versionBefore = await inventoryVersion(first);

  const overview = await settings(first);
  expect(overview.status).toBe(200);
  expect(overview.body.property.id).toBe(first.id);
  expect(overview.body.setup).toMatchObject({
    draft_present: true,
    draft_completed: true,
  });
  expect(overview.body.counts).toMatchObject({
    resources: 4,
    products: 6,
    compositions_active: 2,
  });
  expect(overview.body.scheduled_changes).toEqual([]);
  expect(Array.isArray(overview.body.recent_changes)).toBe(true);
  expect(
    overview.body.recent_changes.some(
      (row) => row.action === 'setup_draft.applied',
    ),
  ).toBe(true);

  const firstLog = await changes(first);
  expect(firstLog.status).toBe(200);
  expect(firstLog.body.items.length).toBeGreaterThan(0);
  expect(firstLog.body.next_cursor).toBeNull();

  const secondLog = await changes(second);
  expect(secondLog.status).toBe(200);
  expect(
    secondLog.body.items.every(
      (row) => !firstLog.body.items.some((other) => other.id === row.id),
    ),
  ).toBe(true);

  const pageOne = await changes(first, '?limit=1');
  expect(pageOne.status).toBe(200);
  expect(pageOne.body.items).toHaveLength(1);
  expect(typeof pageOne.body.next_cursor).toBe('string');
  const pageTwo = await changes(
    first,
    `?limit=50&cursor=${encodeURIComponent(pageOne.body.next_cursor)}`,
  );
  expect(pageTwo.status).toBe(200);
  expect(
    pageTwo.body.items.every((row) => row.id !== pageOne.body.items[0].id),
  ).toBe(true);

  expect(await inventoryVersion(first)).toBe(versionBefore);
});

test('composition change preview blocks leaves committed to another product', async () => {
  const property = await createProperty(`SET06-C1-${runId}`, 'SET-06 impact');
  await applyDraft(property, villaPartsDraft(property), 'impact');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const replacement = await wholeComposition(property, 'SETUP-VILLA-2');
  const replacementLeaves = await compositionDetail(
    property,
    replacement.composition.id,
  );
  const secondLeaf = replacementLeaves.body.leaves[0].resource_id;
  const resourceCodes = new Map(
    (await resources(property)).map((row) => [row.id, row.code]),
  );
  const secondLeafCode = resourceCodes.get(secondLeaf);
  expect(typeof secondLeafCode).toBe('string');

  const partProduct = (await products(property)).find(
    (row) => row.code === `SETUP-VILLA-${secondLeafCode}`,
  );
  const partHold = await hold(property, partProduct.id, 'impact-part', {
    arrival: addDays(10),
    departure: addDays(12),
  });
  expect(partHold.status).toBe(201);

  const currentLeaves = await compositionDetail(property, whole.composition.id);
  const firstLeaf = currentLeaves.body.leaves[0].resource_id;
  const preview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(9),
    resource_ids: [firstLeaf, secondLeaf],
  });
  expect(preview.status).toBe(200);
  expect(preview.body.verdict).toBe('BLOCKED');
  expect(preview.body.conflicts.length).toBeGreaterThan(0);
  expect(
    preview.body.conflicts.some(
      (row) => row.resource_id === secondLeaf && row.source_kind === 'HOLD',
    ),
  ).toBe(true);
  expect(preview.body.retained_commitments).toEqual([]);

  await releaseHold(property, partHold.body.hold.id);
  const safePreview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(9),
    resource_ids: [firstLeaf, secondLeaf],
  });
  expect(safePreview.body.verdict).toBe('SAFE');
});

test('blocked change writes nothing and keeps the active version and leaves', async () => {
  const property = await createProperty(`SET06-C2-${runId}`, 'SET-06 blocked');
  await applyDraft(property, villaPartsDraft(property), 'blocked');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const before = await compositionDetail(property, whole.composition.id);
  const secondDetail = await compositionDetail(
    property,
    (await wholeComposition(property, 'SETUP-VILLA-2')).composition.id,
  );
  const secondLeaf = secondDetail.body.leaves[0].resource_id;
  const codeById = new Map(
    (await resources(property)).map((row) => [row.id, row.code]),
  );
  const partProduct = (await products(property)).find(
    (row) => row.code === `SETUP-VILLA-${codeById.get(secondLeaf)}`,
  );
  expect(partProduct).toBeTruthy();
  const partHold = await hold(property, partProduct.id, 'blocked-part');
  expect(partHold.status).toBe(201);
  const versionBefore = await inventoryVersion(property);
  const proposedLeaves = [before.body.leaves[0].resource_id, secondLeaf];
  const blockedPreview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(9),
    resource_ids: proposedLeaves,
  });
  expect(blockedPreview.body.verdict).toBe('BLOCKED');
  const applied = await applyChange(property, whole.composition.id, {
    effective_from: addDays(9),
    resource_ids: proposedLeaves,
    preview_fingerprint: blockedPreview.body.fingerprint,
  });
  expect(applied.status).toBe(409);
  expect(applied.body.code).toBe('COMPOSITION_CHANGE_CONFLICT');

  const after = await compositionDetail(property, whole.composition.id);
  expect(after.body.composition).toMatchObject({
    id: before.body.composition.id,
    status: 'ACTIVE',
    version_number: before.body.composition.version_number,
    effective_from: before.body.composition.effective_from,
    effective_to: before.body.composition.effective_to,
  });
  expect(after.body.leaves).toEqual(before.body.leaves);
  expect(await inventoryVersion(property)).toBe(versionBefore);
  await releaseHold(property, partHold.body.hold.id);
});

test('dated change closes the old version, preserves it and schedules the new one', async () => {
  const property = await createProperty(`SET06-D1-${runId}`, 'SET-06 dated');
  await applyDraft(property, singleVillaDraft(property), 'dated');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const before = await compositionDetail(property, whole.composition.id);
  const resourcesByCode = new Map(
    (await resources(property)).map((row) => [row.code, row.id]),
  );
  const leafA = resourcesByCode.get('1-A');
  const leafB = resourcesByCode.get('1-B');
  const leafC = resourcesByCode.get('1-C');
  expect(before.body.leaves).toHaveLength(3);
  expect(new Set(before.body.leaves.map((row) => row.resource_id))).toEqual(
    new Set([leafA, leafB, leafC]),
  );

  const changeFrom = addDays(5);
  const preview = await previewChange(property, whole.composition.id, {
    effective_from: changeFrom,
    resource_ids: [leafA, leafC],
  });
  expect(preview.status).toBe(200);
  expect(preview.body.verdict).toBe('SAFE');
  expect(preview.body.removed_leaves.map((row) => row.resource_id)).toEqual([
    leafB,
  ]);

  const applied = await applyChange(property, whole.composition.id, {
    effective_from: changeFrom,
    resource_ids: [leafA, leafC],
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.composition).toMatchObject({
    product_id: whole.composition.product_id,
    status: 'ACTIVE',
    effective_from: changeFrom,
    effective_to: before.body.composition.effective_to,
    version_number: before.body.composition.version_number + 1,
  });
  expect(applied.body.superseded).toMatchObject({
    id: before.body.composition.id,
    status: 'ACTIVE',
    effective_from: before.body.composition.effective_from,
    effective_to: addDays(4),
    version_number: before.body.composition.version_number,
  });

  const oldDetail = await compositionDetail(
    property,
    before.body.composition.id,
  );
  expect(oldDetail.body.leaves).toEqual(before.body.leaves);
  const newDetail = await compositionDetail(
    property,
    applied.body.composition.id,
  );
  expect(new Set(newDetail.body.leaves.map((row) => row.resource_id))).toEqual(
    new Set([leafA, leafC]),
  );

  const overview = await settings(property);
  expect(
    overview.body.scheduled_changes.some(
      (row) => row.composition_id === applied.body.composition.id,
    ),
  ).toBe(true);

  const crossing = await hold(property, whole.product.id, 'crossing', {
    arrival: addDays(4),
    departure: addDays(6),
    adults: 6,
  });
  expect(crossing.status).toBe(409);
  expect(crossing.body.code).toBe('RESOURCE_UNAVAILABLE');
  const afterBoundary = await hold(property, whole.product.id, 'after', {
    arrival: addDays(6),
    departure: addDays(7),
    adults: 6,
  });
  expect(afterBoundary.status).toBe(201);
  await releaseHold(property, afterBoundary.body.hold.id);

  const partB = (await products(property)).find(
    (row) => row.code === 'SETUP-VILLA-1-B',
  );
  const removedLeafHold = await hold(property, partB.id, 'removed-leaf', {
    arrival: addDays(6),
    departure: addDays(7),
  });
  expect(removedLeafHold.status).toBe(201);
  await releaseHold(property, removedLeafHold.body.hold.id);
});

test('same-day change keeps a single inclusive day for the closed version', async () => {
  const property = await createProperty(`SET06-D3-${runId}`, 'SET-06 same day');
  await applyDraft(property, singleVillaDraft(property), 'same-day');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);
  const preview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(1),
    resource_ids: leafIds,
  });
  expect(preview.body.verdict).toBe('SAFE');
  const applied = await applyChange(property, whole.composition.id, {
    effective_from: addDays(1),
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.superseded).toMatchObject({
    id: detail.body.composition.id,
    effective_from: detail.body.composition.effective_from,
    effective_to: detail.body.composition.effective_from,
    status: 'ACTIVE',
  });
  expect(applied.body.composition.effective_from).toBe(addDays(1));
});

test('dated change rejects backdating, stale previews and window overlap', async () => {
  const property = await createProperty(`SET06-D2-${runId}`, 'SET-06 guards');
  await applyDraft(property, singleVillaDraft(property), 'guards');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);

  const backdated = await previewChange(property, whole.composition.id, {
    effective_from: addDays(-1),
    resource_ids: leafIds,
  });
  expect(backdated.status).toBe(400);
  expect(backdated.body.code).toBe('INVALID_REQUEST');

  const preview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(7),
    resource_ids: [leafIds[1], leafIds[0]],
  });
  expect(preview.body.verdict).toBe('SAFE');
  const stale = await applyChange(property, whole.composition.id, {
    effective_from: addDays(8),
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('PREVIEW_STALE');

  const overlap = await applyMigration(property, {
    product_id: whole.composition.product_id,
    effective_from: addDays(30),
    resource_ids: leafIds,
    preview_fingerprint: 'a'.repeat(64),
  });
  expect(overlap.status).toBe(409);
  expect(overlap.body.code).toBe('COMPOSITION_WINDOW_CONFLICT');

  const stillActive = await compositionDetail(property, whole.composition.id);
  expect(stillActive.body.composition.status).toBe('ACTIVE');
  expect(stillActive.body.composition.effective_to).toBe(
    detail.body.composition.effective_to,
  );
  expect(stillActive.body.leaves).toEqual(detail.body.leaves);
});

test('isolated migration preserves resource ids and refuses duplicates', async () => {
  const property = await createProperty(
    `SET06-M1-${runId}`,
    'SET-06 migration',
  );
  await applyDraft(property, roomsDraft(property), 'migration');
  const roomProduct = (await products(property)).find(
    (row) => row.code === 'SETUP-ROOM-201',
  );
  const beforeResources = await resources(property);
  const room = beforeResources.find((row) => row.code === '201');
  expect(await compositions(property)).toEqual([]);

  const preview = await previewMigration(property, {
    product_id: roomProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(60),
    resource_ids: [room.id],
  });
  expect(preview.status).toBe(200);
  expect(preview.body.verdict).toBe('SAFE');
  expect(preview.body.before).toMatchObject({
    resources: beforeResources.length,
    future_commitments: 0,
    active_compositions: 0,
    product_active_versions: 0,
  });
  expect(preview.body.after).toMatchObject({
    resources: beforeResources.length,
    future_commitments: 0,
    active_compositions: 1,
    product_active_versions: 1,
  });

  const applied = await applyMigration(property, {
    product_id: roomProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(60),
    resource_ids: [room.id],
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(201);
  expect(applied.body.composition).toMatchObject({
    product_id: roomProduct.id,
    status: 'ACTIVE',
    version_number: 1,
  });
  expect(applied.body.reconciliation).toMatchObject({
    resource_ids_preserved: true,
    resource_ids: [room.id],
  });
  expect(applied.body.reconciliation.after).toMatchObject({
    resources: beforeResources.length,
    future_commitments: 0,
    active_compositions: 1,
    product_active_versions: 1,
  });

  const afterResources = await resources(property);
  expect(afterResources.map((row) => row.id).sort()).toEqual(
    beforeResources.map((row) => row.id).sort(),
  );
  const leaves = await compositionDetail(property, applied.body.composition.id);
  expect(leaves.body.leaves.map((row) => row.resource_id)).toEqual([room.id]);

  const duplicate = await applyMigration(property, {
    product_id: roomProduct.id,
    effective_from: addDays(2),
    effective_to: addDays(60),
    resource_ids: [room.id],
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('COMPOSITION_WINDOW_CONFLICT');
  expect(await compositions(property)).toHaveLength(1);
});

test('reconciliation reports invariants and shared resources', async () => {
  const property = await createProperty(
    `SET06-R1-${runId}`,
    'SET-06 reconcile',
  );
  await applyDraft(property, villaPartsDraft(property), 'reconcile');
  const clean = await reconciliation(property);
  expect(clean.status).toBe(200);
  expect(clean.body.counts).toMatchObject({
    resources: 4,
    products: 6,
    active_compositions: 2,
  });
  const overlap = clean.body.checks.find(
    (row) => row.code === 'WINDOW_OVERLAP',
  );
  expect(overlap.status).toBe('PASS');
  const shared = clean.body.checks.find(
    (row) => row.code === 'SHARED_RESOURCE',
  );
  expect(shared.status).toBe('PASS');
  const coverage = clean.body.checks.find(
    (row) => row.code === 'COMMITMENT_COVERAGE',
  );
  expect(['PASS', 'WARN']).toContain(coverage.status);

  const partProduct = (await products(property)).find(
    (row) => row.code === 'SETUP-VILLA-1-A',
  );
  const partResource = (await resources(property)).find(
    (row) => row.code === '1-A',
  );
  const preview = await previewMigration(property, {
    product_id: partProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(60),
    resource_ids: [partResource.id],
  });
  expect(preview.body.verdict).toBe('SAFE');
  const applied = await applyMigration(property, {
    product_id: partProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(60),
    resource_ids: [partResource.id],
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(201);

  const annotated = await reconciliation(property);
  const sharedAfter = annotated.body.checks.find(
    (row) => row.code === 'SHARED_RESOURCE',
  );
  expect(sharedAfter.status).toBe('WARN');
  expect(
    sharedAfter.details.some((row) => row.resource_id === partResource.id),
  ).toBe(true);
  expect(annotated.body.counts.active_compositions).toBe(3);
});

test('change permissions and cross-property scope are enforced', async () => {
  const first = await createProperty(`SET06-Z1-${runId}`, 'SET-06 scope A');
  const second = await createProperty(`SET06-Z2-${runId}`, 'SET-06 scope B');
  await applyDraft(first, singleVillaDraft(first), 'scope-a');
  await applyDraft(second, roomsDraft(second), 'scope-b');
  const whole = await wholeComposition(first, 'SETUP-VILLA-1');
  const detail = await compositionDetail(first, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);

  const readPreview = await previewChange(
    first,
    whole.composition.id,
    { effective_from: addDays(3), resource_ids: leafIds },
    auditor,
  );
  expect(readPreview.status).toBe(200);

  const forbidden = await applyChange(
    first,
    whole.composition.id,
    {
      effective_from: addDays(3),
      resource_ids: leafIds,
      preview_fingerprint: readPreview.body.fingerprint,
    },
    auditor,
  );
  expect(forbidden.status).toBe(403);

  const hidden = await compositionDetail(second, whole.composition.id);
  expect(hidden.status).toBe(404);
  expect(hidden.body.code).toBe('NOT_FOUND');
});

function previousIsoDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

test('apply operations demand an idempotency key and replay the stored result', async () => {
  const property = await createProperty(
    `SET06-I2-${runId}`,
    'SET-06 apply contract',
  );
  await applyDraft(property, singleVillaDraft(property), 'apply-contract');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);

  const preview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(5),
    resource_ids: leafIds,
  });
  expect(preview.body.verdict).toBe('SAFE');
  const body = {
    effective_from: addDays(5),
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  };

  const missing = await applyChange(
    property,
    whole.composition.id,
    body,
    admin,
    { idempotencyKey: null },
  );
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');

  const replayKey = `set06-${runId}-replay`;
  const first = await applyChange(property, whole.composition.id, body, admin, {
    idempotencyKey: replayKey,
  });
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);

  const second = await applyChange(
    property,
    whole.composition.id,
    body,
    admin,
    { idempotencyKey: replayKey },
  );
  expect(second.status).toBe(200);
  expect(second.body.replayed).toBe(true);
  expect(second.body.composition.id).toBe(first.body.composition.id);
  expect(second.body.superseded.id).toBe(first.body.superseded.id);
  expect(await compositions(property)).toHaveLength(2);

  const reused = await applyChange(
    property,
    whole.composition.id,
    { ...body, effective_from: addDays(6) },
    admin,
    { idempotencyKey: replayKey },
  );
  expect(reused.status).toBe(409);
  expect(reused.body.code).toBe('CONFLICT');
});

test('migration apply replays and preserves resource ids end to end', async () => {
  const property = await createProperty(
    `SET06-I3-${runId}`,
    'SET-06 migration contract',
  );
  await applyDraft(property, roomsDraft(property), 'migration-contract');
  const roomProduct = (await products(property)).find(
    (row) => row.code === 'SETUP-ROOM-201',
  );
  const resourcesBefore = await resources(property);
  const room = resourcesBefore.find((row) => row.code === '201');
  const preview = await previewMigration(property, {
    product_id: roomProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(30),
    resource_ids: [room.id],
  });
  expect(preview.body.verdict).toBe('SAFE');
  const body = {
    product_id: roomProduct.id,
    effective_from: addDays(1),
    effective_to: addDays(30),
    resource_ids: [room.id],
    preview_fingerprint: preview.body.fingerprint,
  };

  const missing = await applyMigration(property, body, admin, {
    idempotencyKey: null,
  });
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');

  const replayKey = `set06-${runId}-migration-replay`;
  const first = await applyMigration(property, body, admin, {
    idempotencyKey: replayKey,
  });
  expect(first.status).toBe(201);
  expect(first.body.replayed).toBe(false);
  expect(first.body.reconciliation.resource_ids_preserved).toBe(true);

  const second = await applyMigration(property, body, admin, {
    idempotencyKey: replayKey,
  });
  expect(second.status).toBe(201);
  expect(second.body.replayed).toBe(true);
  expect(second.body.composition.id).toBe(first.body.composition.id);

  const resourcesAfter = await resources(property);
  expect(resourcesAfter.map((row) => row.id).sort()).toEqual(
    resourcesBefore.map((row) => row.id).sort(),
  );
  expect(await compositions(property)).toHaveLength(1);
});

test('preview fingerprint follows blocks added after the preview', async () => {
  const property = await createProperty(
    `SET06-I4-${runId}`,
    'SET-06 fingerprint',
  );
  await applyDraft(property, singleVillaDraft(property), 'fingerprint');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);

  const preview = await previewChange(property, whole.composition.id, {
    effective_from: addDays(6),
    resource_ids: leafIds,
  });
  expect(preview.body.verdict).toBe('SAFE');

  const blocked = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [leafIds[0]],
        period: { arrival: addDays(6), departure: addDays(8) },
        reason: 'SET-06 fingerprint probe',
        mode: 'PLANNED',
      },
      headers: { 'idempotency-key': key('fingerprint-block') },
    },
  );
  expect(blocked.status).toBe(201);

  const stale = await applyChange(property, whole.composition.id, {
    effective_from: addDays(6),
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('PREVIEW_STALE');
  expect(await compositions(property)).toHaveLength(1);
});

test('single day windows are accepted for changes and migrations', async () => {
  const property = await createProperty(
    `SET06-D7-${runId}`,
    'SET-06 single day',
  );
  await applyDraft(property, singleVillaDraft(property), 'single-day');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);
  const day = addDays(4);

  const preview = await previewChange(property, whole.composition.id, {
    effective_from: day,
    effective_to: day,
    resource_ids: leafIds,
  });
  expect(preview.status).toBe(200);
  expect(preview.body.verdict).toBe('SAFE');
  const applied = await applyChange(property, whole.composition.id, {
    effective_from: day,
    effective_to: day,
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.composition.effective_from).toBe(day);
  expect(applied.body.composition.effective_to).toBe(day);

  const second = await createProperty(
    `SET06-D8-${runId}`,
    'SET-06 single day migration',
  );
  await applyDraft(second, roomsDraft(second), 'single-day-migration');
  const roomProduct = (await products(second)).find(
    (row) => row.code === 'SETUP-ROOM-201',
  );
  const room = (await resources(second)).find((row) => row.code === '201');
  const migrationPreview = await previewMigration(second, {
    product_id: roomProduct.id,
    effective_from: day,
    effective_to: day,
    resource_ids: [room.id],
  });
  expect(migrationPreview.status).toBe(200);
  const migrationApplied = await applyMigration(second, {
    product_id: roomProduct.id,
    effective_from: day,
    effective_to: day,
    resource_ids: [room.id],
    preview_fingerprint: migrationPreview.body.fingerprint,
  });
  expect(migrationApplied.status).toBe(201);
  expect(migrationApplied.body.composition.effective_from).toBe(day);
  expect(migrationApplied.body.composition.effective_to).toBe(day);
});

test('setup change log rejects malformed cursors with 400', async () => {
  const property = await createProperty(`SET06-D5-${runId}`, 'SET-06 cursor');
  await applyDraft(property, singleVillaDraft(property), 'cursor');

  const badTimestamp = await changes(property, '?cursor=2026-99-99Tbad|x');
  expect(badTimestamp.status).toBe(400);
  expect(badTimestamp.body.code).toBe('INVALID_REQUEST');

  const badId = await changes(
    property,
    '?cursor=2026-09-01T00:00:00Z|not-a-uuid',
  );
  expect(badId.status).toBe(400);
  expect(badId.body.code).toBe('INVALID_REQUEST');

  for (const calendar of [
    '2026-02-30',
    '2026-02-29',
    '2026-04-31',
    '2026-06-31',
    '2026-09-31',
    '2026-11-31',
  ]) {
    const impossible = await changes(
      property,
      `?cursor=${calendar}T00:00:00Z|00000000-0000-4000-8000-000000000000`,
    );
    expect(impossible.status).toBe(400);
    expect(impossible.body.code).toBe('INVALID_REQUEST');
  }
  const leapDay = await changes(
    property,
    '?cursor=2028-02-29T00:00:00Z|00000000-0000-4000-8000-000000000000',
  );
  expect(leapDay.status).toBe(200);

  const pageOne = await changes(property, '?limit=1');
  expect(pageOne.status).toBe(200);
  if (pageOne.body.next_cursor) {
    const pageTwo = await apiRequest(
      admin.context,
      'GET',
      `/tenants/${tenantA}/properties/${property.id}/setup-changes?limit=1&cursor=${encodeURIComponent(pageOne.body.next_cursor)}`,
    );
    expect(pageTwo.status).toBe(200);
  }
});

test('dated changes compare against the property business date', async () => {
  setClockForTests(() => new Date('2026-09-21T17:30:00Z'));
  try {
    expect(businessToday('Asia/Makassar')).toBe('2026-09-22');
    expect(businessToday('Asia/Jakarta')).toBe('2026-09-22');
    expect(businessToday('UTC')).toBe('2026-09-21');
    expect(() =>
      assertNotBackdated('2026-09-22', businessToday('Asia/Jakarta')),
    ).not.toThrow();
    expect(() =>
      assertNotBackdated('2026-09-21', businessToday('Asia/Jakarta')),
    ).toThrow('INVALID_REQUEST');
  } finally {
    setClockForTests(null);
  }

  const property = await createProperty(
    `SET06-D6-${runId}`,
    'SET-06 business date',
  );
  await applyDraft(property, singleVillaDraft(property), 'business-date');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);
  const today = businessToday('Asia/Jakarta');

  const rejected = await previewChange(property, whole.composition.id, {
    effective_from: previousIsoDate(today),
    resource_ids: leafIds,
  });
  expect(rejected.status).toBe(400);
  expect(rejected.body.code).toBe('INVALID_REQUEST');

  const accepted = await previewChange(property, whole.composition.id, {
    effective_from: today,
    resource_ids: leafIds,
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body.verdict).toBe('SAFE');
});

test('T27 rejects impossible calendar dates and keeps a leap-day version boundary exact', async () => {
  const property = await createProperty(
    `SET06-T27-${runId}`,
    'SET-06 calendar boundary',
  );
  await applyDraft(property, singleVillaDraft(property), 't27-calendar');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const original = await compositionDetail(property, whole.composition.id);
  const leafIds = original.body.leaves.map((row) => row.resource_id);
  const before = await inventoryVersion(property);

  for (const invalid of [
    '2027-02-29',
    '2028-02-30',
    '2028-04-31',
    '0000-01-01',
  ]) {
    const response = await previewChange(property, whole.composition.id, {
      effective_from: invalid,
      resource_ids: leafIds,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
    expect(response.body.details.field).toBe('effective_from');
  }
  const invalidEnd = await previewChange(property, whole.composition.id, {
    effective_from: '2028-02-29',
    effective_to: '2028-02-30',
    resource_ids: leafIds,
  });
  expect(invalidEnd.status).toBe(400);
  expect(invalidEnd.body.details.field).toBe('effective_to');
  const directApply = await applyChange(property, whole.composition.id, {
    effective_from: '2028-02-30',
    resource_ids: leafIds,
    preview_fingerprint: 'a'.repeat(64),
  });
  expect(directApply.status).toBe(400);
  expect(directApply.body.details.field).toBe('effective_from');
  const migration = await previewMigration(property, {
    product_id: whole.product.id,
    effective_from: '2028-02-30',
    resource_ids: leafIds,
  });
  expect(migration.status).toBe(400);
  expect(migration.body.details.field).toBe('effective_from');
  expect(await inventoryVersion(property)).toBe(before);
  expect(
    (await compositionDetail(property, whole.composition.id)).body,
  ).toEqual(original.body);

  const leapDay = await previewChange(property, whole.composition.id, {
    effective_from: '2028-02-29',
    effective_to: '2028-03-01',
    resource_ids: leafIds,
  });
  expect(leapDay.status).toBe(200);
  expect(leapDay.body.verdict).toBe('SAFE');
  const applied = await applyChange(property, whole.composition.id, {
    effective_from: '2028-02-29',
    effective_to: '2028-03-01',
    resource_ids: leafIds,
    preview_fingerprint: leapDay.body.fingerprint,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.superseded.effective_to).toBe('2028-02-28');
  expect(applied.body.composition.effective_from).toBe('2028-02-29');
  expect(applied.body.composition.effective_to).toBe('2028-03-01');
  expect(
    (await compositionDetail(property, whole.composition.id)).body.leaves,
  ).toEqual(original.body.leaves);
});

test('migration-retired versions cannot return without provenance', async () => {
  const property = await createProperty(
    `SET06-P1-${runId}`,
    'SET-06 provenance',
  );
  await applyDraft(property, singleVillaDraft(property), 'provenance');
  const whole = await wholeComposition(property, 'SETUP-VILLA-1');
  const detail = await compositionDetail(property, whole.composition.id);
  const leafIds = detail.body.leaves.map((row) => row.resource_id);
  // v1 seeds its first version on the UTC date, which can already be
  // yesterday in Jakarta. Create a future version through the supported
  // change API, then replace that version on its own start date.
  const effectiveFrom = addDays(2);
  const futurePreview = await previewChange(property, whole.composition.id, {
    effective_from: effectiveFrom,
    resource_ids: leafIds,
  });
  expect(futurePreview).toMatchObject({
    status: 200,
    body: { verdict: 'SAFE' },
  });
  const futureVersion = await applyChange(property, whole.composition.id, {
    effective_from: effectiveFrom,
    resource_ids: leafIds,
    preview_fingerprint: futurePreview.body.fingerprint,
  });
  expect(futureVersion.status).toBe(200);
  const compositionId = futureVersion.body.composition.id;

  const preview = await previewChange(property, compositionId, {
    effective_from: effectiveFrom,
    resource_ids: leafIds,
  });
  expect(preview).toMatchObject({ status: 200, body: { verdict: 'SAFE' } });
  const applied = await applyChange(property, compositionId, {
    effective_from: effectiveFrom,
    resource_ids: leafIds,
    preview_fingerprint: preview.body.fingerprint,
  });
  expect(applied.status).toBe(200);
  expect(applied.body.superseded.status).toBe('RETIRED');
  const retiredId = applied.body.superseded.id;

  await expect(
    withOwner(async (client) =>
      client.query(
        `update "composition_version"
            set "status" = 'ACTIVE'
          where "id" = $1`,
        [retiredId],
      ),
    ),
  ).rejects.toThrow(/composition revival requires/);

  await withOwner(async (client) => {
    await client.query('begin');
    await client.query(
      `insert into "composition_status_audit"
         ("tenant_id", "property_id", "composition_version_id",
          "from_status", "to_status", "reason", "migration")
       select "tenant_id", "property_id", "id", 'RETIRED', 'ACTIVE',
              'test_approved_revival', 'test'
         from "composition_version"
        where "id" = $1`,
      [retiredId],
    );
    await client.query(
      `update "composition_version"
          set "status" = 'ACTIVE'
        where "id" = $1`,
      [retiredId],
    );
    await client.query('rollback');
  });

  const residual = await withOwner(async (client) =>
    client.query(
      `select count(*)::int as "count"
         from "composition_version" v
        where v."status" = 'ACTIVE'
          and exists (
            select 1 from "audit_event" a
             where a."tenant_id" = v."tenant_id"
               and a."property_id" = v."property_id"
               and a."action" = 'composition.superseded'
               and a."after_safe" ->> 'retired' = 'true'
               and a."before_safe" ->> 'composition_id' = v."id"::text
          )`,
    ),
  );
  expect(residual.rows[0].count).toBe(0);
});

test('overlap and period migrations refuse an unsafe down()', async () => {
  const names = [
    'Migration20260921160000_composition_dated_changes',
    'Migration20260921170000_composition_overlap_relax',
    'Migration20260921180000_composition_period_allow_single_day',
    'Migration20260922100000_composition_revival_provenance',
  ];
  for (const name of names) {
    const module = await import(
      `../../packages/backend/dist/persistence/migrations/${name}.js`
    );
    const instance = new module[name]();
    await expect(instance.down()).rejects.toThrow(/forward-only/);
  }
});
