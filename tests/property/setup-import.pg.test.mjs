import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';

let tenantA;
let admin;
let auditor;
let member;
let property;

const runId = Date.now().toString(36);
const key = (name) => `set04i-${runId}-${name}`;
const HEADER = 'code,template,capacity,location';

async function importUnits(target, mode, content, name) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-unit-imports`,
    {
      body: { mode, file_name: `${name}.csv`, content },
      headers: { 'idempotency-key': key(name) },
    },
  );
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

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  member = await loginAs('member-a');
  tenantA = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `SET04I-${runId.toUpperCase()}`,
        name: 'SET-04 import',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const location = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/locations`,
    {
      body: { code: 'BLOCK-A', name: 'Block A' },
      headers: { 'idempotency-key': key('location') },
    },
  );
  expect(location.status).toBe(201);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('dry-run reports every row and writes nothing', async () => {
  const content = [
    HEADER,
    '101,ROOM,2,',
    '102,ROOM,,',
    '103,VILLA,4,BLOCK-A',
    'BAD1,UNKNOWN,2,',
    '101,ROOM,2,',
    '=evil,ROOM,2,',
    '104,ROOM,0,',
    '105,ROOM,2,NOPE',
  ].join('\n');
  const response = await importUnits(property, 'DRY_RUN', content, 'dry');
  expect(response.status).toBe(200);
  expect(response.body.applied).toBe(false);
  expect(response.body.file_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.totals).toEqual({
    rows: 8,
    accepted: 3,
    rejected: 5,
    duplicates: 1,
    created: 0,
  });
  const byLine = Object.fromEntries(
    response.body.rows.map((row) => [row.line_no, row.error_code]),
  );
  expect(byLine[5]).toBe('TEMPLATE_UNKNOWN');
  expect(byLine[6]).toBe('DUPLICATE_IN_FILE');
  expect(byLine[7]).toBe('UNSAFE_CONTENT');
  expect(byLine[8]).toBe('CAPACITY_INVALID');
  expect(byLine[9]).toBe('LOCATION_UNKNOWN');
  expect(await resources(property)).toEqual([]);
});

test('unreadable files are rejected before any row work', async () => {
  const response = await importUnits(
    property,
    'DRY_RUN',
    'room,template\n101,ROOM',
    'header',
  );
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('SETUP_IMPORT_INVALID');
  expect(response.body.details.error).toBe('HEADER_INVALID');
});

test('apply creates the accepted rows only and records the run', async () => {
  const content = [
    HEADER,
    '101,ROOM,2,',
    '102,ROOM,,',
    '103,VILLA,4,BLOCK-A',
    '104,ROOM,0,',
  ].join('\n');
  const response = await importUnits(property, 'APPLY', content, 'apply');
  expect(response.status).toBe(200);
  expect(response.body.applied).toBe(true);
  expect(response.body.totals.created).toBe(3);
  expect(response.body.totals.rejected).toBe(1);
  const created = response.body.rows.filter((row) => row.status === 'CREATED');
  expect(created.map((row) => row.code)).toEqual(['101', '102', '103']);

  const items = await resources(property);
  expect(items.map((item) => item.code).sort()).toEqual(['101', '102', '103']);
  const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
  expect(byCode['101'].capacity).toBe(2);
  expect(byCode['102'].capacity).toBe(2);
  expect(byCode['103'].capacity).toBe(4);
  expect(byCode['103'].location_id).toBeTruthy();
});

test('re-applying the same file is stopped by existing unit codes', async () => {
  const content = [
    HEADER,
    '101,ROOM,2,',
    '102,ROOM,,',
    '103,VILLA,4,BLOCK-A',
  ].join('\n');
  const response = await importUnits(property, 'APPLY', content, 'reapply');
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('CONFLICT');
  expect(response.body.details.reason).toBe('setup_codes_exist');
  expect(await resources(property)).toHaveLength(3);
});

test('idempotent replay returns the stored report without duplicates', async () => {
  const content = [HEADER, '201,ROOM,2,', '202,ROOM,2,'].join('\n');
  const first = await importUnits(property, 'APPLY', content, 'replay');
  expect(first.status).toBe(200);
  expect(first.body.totals.created).toBe(2);
  const second = await importUnits(property, 'APPLY', content, 'replay');
  expect(second.status).toBe(200);
  expect(second.body.replayed).toBe(true);
  expect(second.body.totals.created).toBe(2);
  expect(await resources(property)).toHaveLength(5);
});

test('batches above the inline limit fail closed', async () => {
  const rows = Array.from(
    { length: 21 },
    (_, index) => `${300 + index},ROOM,2,`,
  );
  const response = await importUnits(
    property,
    'APPLY',
    [HEADER, ...rows].join('\n'),
    'limit',
  );
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('SETUP_BATCH_TASK_REQUIRED');
  expect(await resources(property)).toHaveLength(5);
});

test('a file with only unknown locations applies nothing', async () => {
  const response = await importUnits(
    property,
    'APPLY',
    [HEADER, '401,ROOM,2,NOPE'].join('\n'),
    'location',
  );
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('SETUP_IMPORT_INVALID');
  expect(response.body.details.error).toBe('NO_VALID_ROWS');
  expect(await resources(property)).toHaveLength(5);
});

test('members without resource permission cannot import', async () => {
  const response = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
    {
      body: { mode: 'DRY_RUN', file_name: 'member.csv', content: HEADER },
      headers: { 'idempotency-key': key('member') },
    },
  );
  expect(response.status).toBe(403);
});
