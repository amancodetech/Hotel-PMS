import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenant;
let admin;
let property;
let productId;

const runId = String(Date.now()).slice(-6);

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

function csv(lines) {
  return [
    'external_key,arrival,departure,adults,quantity,product_code',
    ...lines,
  ].join('\n');
}

async function importCsv(body) {
  return apiRequest(admin.context, 'POST', `${base()}/imports`, {
    body: {
      mode: 'DRY_RUN',
      source: 'UPLOAD',
      file_name: `p65-${runId}.csv`,
      content_type: 'text/csv',
      ...body,
    },
  });
}

async function reservationCount(keyPrefix) {
  return withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "reservation"
            where "property_id" = $1 and "external_booking_key" like $2`,
          [property.id, `${keyPrefix}%`],
        )
      ).rows[0].count,
    ),
  );
}

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
        code: `P65-${runId}`,
        name: `P06-05 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P65-P-${runId}`,
        name: 'P06-05 room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  productId = product.body.product.id;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P06-05 dry-run reports rows without creating reservations and replays identical files', async () => {
  const content = csv([
    `P65-DRY-${runId}-A,${addDays(100)},${addDays(102)},2,1,`,
    `P65-DRY-${runId}-B,${addDays(103)},${addDays(105)},2,1,`,
    `P65-DRY-${runId}-C,not-a-date,${addDays(106)},2,1,`,
  ]);
  const report = await importCsv({ content });
  expect(report.status).toBe(200);
  expect(report.body.rows_total).toBe(3);
  expect(report.body.rows_accepted).toBe(2);
  expect(report.body.rows_rejected).toBe(1);
  expect(
    report.body.rows.find((row) => row.status === 'REJECTED').error_code,
  ).toBe('INVALID_DATE');
  expect(await reservationCount(`P65-DRY-${runId}`)).toBe(0);
  const replay = await importCsv({ content });
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.run_id).toBe(report.body.run_id);
});

test('P06-05 apply creates each booking once and a second feed with same keys is duplicate', async () => {
  const content = csv([
    `P65-APP-${runId}-A,${addDays(100)},${addDays(102)},2,1,`,
    `P65-APP-${runId}-B,${addDays(103)},${addDays(105)},2,1,`,
  ]);
  const applied = await importCsv({ content, mode: 'APPLY', source: 'FEED' });
  expect(applied.status).toBe(200);
  expect(applied.body.rows_accepted).toBe(2);
  expect(await reservationCount(`P65-APP-${runId}`)).toBe(2);
  const replay = await importCsv({ content, mode: 'APPLY', source: 'FEED' });
  expect(replay.body.replayed).toBe(true);
  expect(await reservationCount(`P65-APP-${runId}`)).toBe(2);
  const secondFeed = csv([
    `P65-APP-${runId}-A,${addDays(100)},${addDays(102)},2,1,`,
    `P65-APP-${runId}-C,${addDays(107)},${addDays(109)},2,1,`,
  ]);
  const second = await importCsv({
    content: secondFeed,
    mode: 'APPLY',
    source: 'FEED',
  });
  expect(second.body.rows_duplicate).toBe(1);
  expect(second.body.rows_accepted).toBe(1);
  expect(await reservationCount(`P65-APP-${runId}`)).toBe(3);
});

test('P06-05 parallel applies with the same external_key keep a single reservation', async () => {
  const key = `P65-RACE-${runId}`;
  const firstContent = csv([`${key},${addDays(120)},${addDays(122)},2,1,`]);
  const secondContent = csv([`${key},${addDays(124)},${addDays(126)},2,1,`]);
  const [first, second] = await Promise.all([
    importCsv({ content: firstContent, mode: 'APPLY', source: 'FEED' }),
    importCsv({ content: secondContent, mode: 'APPLY', source: 'FEED' }),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const accepted = first.body.rows_accepted + second.body.rows_accepted;
  const duplicate = first.body.rows_duplicate + second.body.rows_duplicate;
  expect(accepted).toBe(1);
  expect(duplicate).toBe(1);
  expect(await reservationCount(key)).toBe(1);
  const duplicateReport = first.body.rows_duplicate === 1 ? first : second;
  expect(duplicateReport.body.rows[0].status).toBe('DUPLICATE');
  const sideEffects = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "items" from "reservation_item"
        where "reservation_id" = (
          select "id" from "reservation" where "external_booking_key" = $1
        )`,
      [key],
    );
    return result.rows[0].items;
  });
  expect(sideEffects).toBe(1);
});

test('P06-05 a dry-run report does not block applying the same file and both replay', async () => {
  const key = `P65-DRYAPPLY-${runId}`;
  const content = csv([`${key},${addDays(130)},${addDays(132)},2,1,`]);
  const dry = await importCsv({ content });
  expect(dry.status).toBe(200);
  expect(dry.body.replayed).toBe(false);
  expect(dry.body.rows_accepted).toBe(1);
  expect(await reservationCount(key)).toBe(0);
  const applied = await importCsv({ content, mode: 'APPLY' });
  expect(applied.status).toBe(200);
  expect(applied.body.replayed).toBe(false);
  expect(applied.body.run_id).not.toBe(dry.body.run_id);
  expect(applied.body.rows_accepted).toBe(1);
  expect(await reservationCount(key)).toBe(1);
  const dryReplay = await importCsv({ content });
  expect(dryReplay.body.replayed).toBe(true);
  expect(dryReplay.body.run_id).toBe(dry.body.run_id);
  const applyReplay = await importCsv({ content, mode: 'APPLY' });
  expect(applyReplay.body.replayed).toBe(true);
  expect(applyReplay.body.run_id).toBe(applied.body.run_id);
  expect(await reservationCount(key)).toBe(1);
});

test('P06-05 hostile or malformed input is rejected with precise codes', async () => {
  const badHeader = await importCsv({
    content: 'key,from,to\nX,2026-01-01,2026-01-02',
  });
  expect(badHeader.status).toBe(400);
  expect(badHeader.body.code).toBe('INVALID_REQUEST');
  const badType = await importCsv({
    content: csv([]),
    content_type: 'application/pdf',
  });
  expect(badType.status).toBe(400);
  const oversize = await importCsv({
    content: `${csv([])}\n${'x'.repeat(300 * 1024)}`,
  });
  expect(oversize.status).toBe(413);
  expect(oversize.body.code).toBe('PAYLOAD_TOO_LARGE');
  const hostile = await importCsv({
    content: csv([
      `bad key!,${addDays(100)},${addDays(102)},2,1,`,
      `=cmd|' /C calc'!A0,${addDays(100)},${addDays(102)},2,1,`,
      `P65-CTRL-${runId},${addDays(100)},${addDays(102)},2,1,\u0007bad`,
      `P65-PROD-${runId},${addDays(100)},${addDays(102)},2,1,UNKNOWN-CODE`,
      `P65-ADULTS-${runId},${addDays(100)},${addDays(102)},0,1,`,
    ]),
  });
  expect(hostile.status).toBe(200);
  const codes = hostile.body.rows.map((row) => row.error_code);
  expect(codes).toContain('INVALID_EXTERNAL_KEY');
  expect(codes).toContain('UNSAFE_CELL');
  expect(codes).toContain('CROSS_SCOPE_REFERENCE');
  expect(codes).toContain('INVALID_ADULTS');
});

test('P06-05 a valid product code is linked on the imported item', async () => {
  const key = `P65-LINK-${runId}`;
  const content = csv([
    `${key},${addDays(110)},${addDays(112)},2,1,P65-P-${runId}`,
  ]);
  const applied = await importCsv({ content, mode: 'APPLY' });
  expect(applied.body.rows_accepted).toBe(1);
  const linked = await withOwner(async (client) => {
    const reservation = await client.query(
      `select "id" from "reservation" where "external_booking_key" = $1`,
      [key],
    );
    const item = await client.query(
      `select "product_id", "quantity" from "reservation_item"
        where "reservation_id" = $1`,
      [reservation.rows[0].id],
    );
    return item.rows[0];
  });
  expect(linked.product_id).toBe(productId);
  expect(linked.quantity).toBe(1);
});
