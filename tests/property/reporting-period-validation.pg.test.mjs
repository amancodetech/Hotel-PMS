import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

/**
 * Regression for the export boundary: a period the generator rejects
 * (`date_to <= date_from`, zero nights) must fail fast with 400 at creation and
 * never be queued as a worker job. Found during P13 verification when a test
 * fixture mixed UTC date math with the facility business date.
 */

let tenant;
let admin;
let property;

const runId = String(Date.now()).slice(-6);

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P11PV-${runId}`,
        name: `P11 period validation ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

async function createExport(period) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties/${property.id}/reports/exports`,
    {
      body: { kind: 'REVENUE', period, currency: 'IDR', format: 'CSV' },
      headers: { 'idempotency-key': randomUUID() },
    },
  );
}

async function exportCount() {
  return withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "report_export"
            where "property_id" = $1`,
          [property.id],
        )
      ).rows[0].count,
    ),
  );
}

test('P11 a zero-night export period fails fast without queueing a job', async () => {
  const day = '2026-10-10';
  const response = await createExport({ date_from: day, date_to: day });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INVALID_REQUEST');
  expect(await exportCount()).toBe(0);
});

test('P11 a reversed export period fails fast without queueing a job', async () => {
  const response = await createExport({
    date_from: '2026-10-12',
    date_to: '2026-10-11',
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INVALID_REQUEST');
  expect(await exportCount()).toBe(0);
});

test('P11 a one-night export period is accepted once', async () => {
  const response = await createExport({
    date_from: '2026-10-10',
    date_to: '2026-10-11',
  });
  expect(response.status).toBe(202);
  expect(response.body.export.state).toBe('PENDING');
  expect(await exportCount()).toBe(1);
});
