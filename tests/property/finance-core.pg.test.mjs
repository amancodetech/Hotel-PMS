import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase8Operations } from '../../apps/api/dist/finance/operations.js';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
  withTestRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260916;
const runId = `P08A${seed}`;
const key = (name) => `p08-01-${name}-${runId}`;

const phase8Contract = JSON.parse(
  readFileSync('docs/contracts/phase8.openapi.json', 'utf8'),
);

let admin;
let owner;
let auditor;
let member;
let property;
let propertyB;
let closedDate;
let openedDate;
let journalId;

function localToday(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addIsoDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

function contractOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(phase8Contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const entry = {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: `/api/v1${path}`,
        access: 'permission',
        permission: operation['x-permission'],
      };
      if (operation['x-csrf']) entry.csrf = true;
      operations.push(entry);
    }
  }
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

async function insertDay(client, { tenantId, propertyId, date, state }) {
  const closedAt = state === 'CLOSED' ? new Date().toISOString() : null;
  const result = await client.query(
    `insert into "business_day"
       ("tenant_id", "property_id", "business_date", "state", "closed_at")
     values ($1, $2, $3, $4, $5)
     returning "id"`,
    [tenantId, propertyId, date, state, closedAt],
  );
  return result.rows[0].id;
}

async function insertJournalAs(
  client,
  { tenantId, propertyId, businessDate, sourceType, sourceId, debit, credit },
) {
  await client.query('begin');
  await client.query("select set_config('app.tenant_id', $1, true)", [
    tenantId,
  ]);
  const journal = await client.query(
    `insert into "journal"
       ("tenant_id", "property_id", "business_date", "currency", "source_type",
        "source_id", "total_debit", "total_credit")
     values ($1, $2, $3, 'IDR', $4, $5, $6, $7)
     returning "id"`,
    [tenantId, propertyId, businessDate, sourceType, sourceId, debit, credit],
  );
  const id = journal.rows[0].id;
  await client.query(
    `insert into "journal_line"
       ("tenant_id", "property_id", "journal_id", "line_no", "account_code", "debit", "credit")
     values ($1, $2, $3, 1, 'FOLIO_GUEST', $4, '0'),
            ($1, $2, $3, 2, 'REVENUE_ROOM', '0', $5)`,
    [tenantId, propertyId, id, debit, credit],
  );
  return id;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  auditor = await loginAs('auditor-a');
  member = await loginAs('member-a');
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P08-A-${runId}`,
        name: `P08-01 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  propertyB = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, $3, 'P08-01 B', 'Asia/Jakarta')`,
      [propertyB, tenantB, `P08-B-${runId}`],
    );
  });
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-01 phase 8 contract lists exactly the implemented operations', () => {
  const manifest = [...phase8Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(manifest).toEqual(contractOperations());
  const ids = contractOperations().map((operation) => operation.operationId);
  expect(ids).toContain('GetBusinessDay');
  expect(ids).toContain('RunNightAudit');
});

test('P08-01 business day read is scoped to folio.read and echoes the property-local date', async () => {
  const forbidden = await apiRequest(
    member.context,
    'GET',
    `${base()}/finance/business-day`,
  );
  expect(forbidden.status).toBe(403);
  const allowed = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/finance/business-day`,
  );
  expect(allowed.status).toBe(200);
  expect(allowed.body.timezone).toBe('Asia/Jakarta');
  expect(allowed.body.date).toBe(localToday('Asia/Jakarta'));
  expect(allowed.body.business_day).toBeNull();
  const byOwner = await apiRequest(
    owner.context,
    'GET',
    `${base()}/finance/business-day`,
  );
  expect(byOwner.status).toBe(200);
  expect(byOwner.body.business_day).toBeNull();
});

test('P08-01 closing a day rejects missing MFA, unknown dates and succeeds on the active day', async () => {
  const withoutMfa = await apiRequest(
    owner.context,
    'POST',
    `${base()}/night-audits`,
    {
      body: { business_date: localToday('Asia/Jakarta') },
      headers: { 'idempotency-key': key('audit-no-mfa') },
    },
  );
  expect(withoutMfa.status).toBe(403);
  expect(withoutMfa.body.code).toBe('MFA_REQUIRED');

  const future = await apiRequest(
    admin.context,
    'POST',
    `${base()}/night-audits`,
    {
      body: { business_date: addIsoDays(localToday('Asia/Jakarta'), 5) },
      headers: { 'idempotency-key': key('audit-future') },
    },
  );
  expect(future.status).toBe(409);

  closedDate = localToday('Asia/Jakarta');
  openedDate = addIsoDays(closedDate, 1);
  const closed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/night-audits`,
    {
      body: { business_date: closedDate },
      headers: { 'idempotency-key': key('audit') },
    },
  );
  expect(closed.status).toBe(200);
  expect(closed.body.closed.business_date).toBe(closedDate);
  expect(closed.body.closed.state).toBe('CLOSED');
  expect(closed.body.closed.closed_at).not.toBeNull();
  expect(closed.body.opened.business_date).toBe(openedDate);
  expect(closed.body.opened.state).toBe('OPEN');
  expect(closed.body.business_day.id).toBe(closed.body.opened.id);
  expect(closed.body.replayed).toBe(false);

  const rows = await withOwner(async (client) => {
    const result = await client.query(
      `select "business_date"::text as "business_date", "state", "closed_at"
         from "business_day"
        where "tenant_id" = $1 and "property_id" = $2
        order by "business_date"`,
      [tenantA, property.id],
    );
    return result.rows;
  });
  expect(rows).toHaveLength(2);
  expect(rows[0].state).toBe('CLOSED');
  expect(rows[0].closed_at).not.toBeNull();
  expect(rows[1].business_date).toBe(openedDate);
  expect(rows[1].state).toBe('OPEN');
});

test('P08-01 the same audit key replays without a second close', async () => {
  const before = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count", max("closed_at") as "closed_at"
         from "business_day"
        where "tenant_id" = $1 and "property_id" = $2`,
      [tenantA, property.id],
    );
    return result.rows[0];
  });
  const replay = await apiRequest(
    admin.context,
    'POST',
    `${base()}/night-audits`,
    {
      body: { business_date: closedDate },
      headers: { 'idempotency-key': key('audit') },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.closed.business_date).toBe(closedDate);
  const after = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count", max("closed_at") as "closed_at"
         from "business_day"
        where "tenant_id" = $1 and "property_id" = $2`,
      [tenantA, property.id],
    );
    return result.rows[0];
  });
  expect(after.count).toBe(before.count);
  expect(new Date(after.closed_at).getTime()).toBe(
    new Date(before.closed_at).getTime(),
  );
  const replayDay = await apiRequest(
    admin.context,
    'GET',
    `${base()}/finance/business-day?date=${closedDate}`,
  );
  expect(replayDay.status).toBe(200);
  expect(replayDay.body.business_day.state).toBe('CLOSED');
});

test('P08-01 the database blocks posting outside the property open day', async () => {
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `insert into "journal"
           ("tenant_id", "property_id", "business_date", "currency", "source_type",
            "source_id", "total_debit", "total_credit")
         values ($1, $2, $3, 'IDR', 'BLOCKED', $4, 10, 10)`,
        [tenantA, property.id, closedDate, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `insert into "journal"
           ("tenant_id", "property_id", "business_date", "currency", "source_type",
            "source_id", "total_debit", "total_credit")
         values ($1, $2, $3, 'IDR', 'BLOCKED', $4, 10, 10)`,
        [tenantA, property.id, addIsoDays(openedDate, 30), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  journalId = await withRuntimeRole('api', async (client) => {
    const id = await insertJournalAs(client, {
      tenantId: tenantA,
      propertyId: property.id,
      businessDate: openedDate,
      sourceType: 'MANUAL_TEST',
      sourceId: randomUUID(),
      debit: '60',
      credit: '60',
    });
    await client.query('commit');
    return id;
  });
  const stored = await withOwner(async (client) => {
    const journal = await client.query(
      `select "total_debit", "total_credit", "state", "business_date"::text as "business_date"
         from "journal" where "id" = $1`,
      [journalId],
    );
    const lines = await client.query(
      `select "line_no", "account_code", "debit", "credit"
         from "journal_line" where "journal_id" = $1 order by "line_no"`,
      [journalId],
    );
    return { journal: journal.rows[0], lines: lines.rows };
  });
  expect(stored.journal.state).toBe('POSTED');
  expect(stored.journal.business_date).toBe(openedDate);
  expect(stored.journal.total_debit).toBe(stored.journal.total_credit);
  expect(stored.lines).toHaveLength(2);
});

test('P08-01 posted journal rows are immutable for operational roles', async () => {
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(`update "journal" set "memo" = 'tampered' where "id" = $1`, [
        journalId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  for (const statement of [
    [`delete from "journal" where "id" = $1`, [journalId]],
    [
      `update "journal_line" set "debit" = 0, "credit" = 0 where "journal_id" = $1`,
      [journalId],
    ],
    [`delete from "journal_line" where "journal_id" = $1`, [journalId]],
  ]) {
    await withRuntimeRole('api', async (client) => {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [
        tenantA,
      ]);
      await expect(
        client.query(statement[0], statement[1]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    });
  }
  // P10: the night audit worker executes the close, including the one nightly
  // charge per stay. It gets INSERT-only on the ledger (never UPDATE/DELETE),
  // so a posted journal stays immutable for operational roles.
  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `insert into "journal"
           ("tenant_id", "property_id", "business_date", "currency", "source_type",
            "total_debit", "total_credit")
         values ($1, $2, $3, 'IDR', 'WORKER_TEST', 1, 1)`,
        [tenantA, property.id, openedDate],
      ),
    ).resolves.toBeTruthy();
    await client.query('rollback');
  });
  for (const statement of [
    [`update "journal" set "memo" = 'tampered' where "id" = $1`, [journalId]],
    [`delete from "journal" where "id" = $1`, [journalId]],
    [
      `update "journal_line" set "debit" = 0, "credit" = 0 where "journal_id" = $1`,
      [journalId],
    ],
    [`delete from "journal_line" where "journal_id" = $1`, [journalId]],
  ]) {
    await withRuntimeRole('worker', async (client) => {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [
        tenantA,
      ]);
      await expect(
        client.query(statement[0], statement[1]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    });
  }
  const privileges = await withOwner(async (client) => {
    const result = await client.query(`
      select
        has_table_privilege('hotel_api', 'journal', 'insert') as api_insert,
        has_table_privilege('hotel_api', 'journal', 'update') as api_update,
        has_table_privilege('hotel_api', 'journal', 'delete') as api_delete,
        has_table_privilege('hotel_api', 'journal_line', 'update') as api_line_update,
        has_table_privilege('hotel_worker', 'journal', 'select') as worker_select,
        has_table_privilege('hotel_worker', 'journal', 'insert') as worker_insert,
        has_table_privilege('hotel_worker', 'journal', 'update') as worker_update,
        has_table_privilege('hotel_worker', 'journal', 'delete') as worker_delete,
        has_table_privilege('hotel_worker', 'journal_line', 'update') as worker_line_update,
        has_table_privilege('hotel_worker', 'journal_line', 'delete') as worker_line_delete
    `);
    return result.rows[0];
  });
  expect(privileges.api_insert).toBe(true);
  expect(privileges.api_update).toBe(false);
  expect(privileges.api_delete).toBe(false);
  expect(privileges.api_line_update).toBe(false);
  expect(privileges.worker_select).toBe(true);
  expect(privileges.worker_insert).toBe(true);
  expect(privileges.worker_update).toBe(false);
  expect(privileges.worker_delete).toBe(false);
  expect(privileges.worker_line_update).toBe(false);
  expect(privileges.worker_line_delete).toBe(false);
});

test('P08-01 the database rejects unbalanced or invalid journals at commit', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const journal = await client.query(
      `insert into "journal"
         ("tenant_id", "property_id", "business_date", "currency", "source_type",
          "source_id", "total_debit", "total_credit")
       values ($1, $2, $3, 'IDR', 'UNBALANCED_TEST', $4, 10, 10)
       returning "id"`,
      [tenantA, property.id, openedDate, randomUUID()],
    );
    const id = journal.rows[0].id;
    await client.query(
      `insert into "journal_line"
         ("tenant_id", "property_id", "journal_id", "line_no", "account_code", "debit", "credit")
       values ($1, $2, $3, 1, 'FOLIO_GUEST', 10, 0),
              ($1, $2, $3, 2, 'REVENUE_ROOM', 0, 9)`,
      [tenantA, property.id, id],
    );
    await expect(client.query('commit')).rejects.toMatchObject({
      code: '23514',
    });
    await client.query('rollback');
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `insert into "journal"
           ("tenant_id", "property_id", "business_date", "currency", "source_type",
            "total_debit", "total_credit")
         values ($1, $2, $3, 'EUR', 'CURRENCY_TEST', 1, 1)`,
        [tenantA, property.id, openedDate],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const journal = await client.query(
      `insert into "journal"
         ("tenant_id", "property_id", "business_date", "currency", "source_type",
          "source_id", "total_debit", "total_credit")
       values ($1, $2, $3, 'IDR', 'SCALE_TEST', $4, 10, 10)
       returning "id"`,
      [tenantA, property.id, openedDate, randomUUID()],
    );
    await expect(
      client.query(
        `insert into "journal_line"
           ("tenant_id", "property_id", "journal_id", "line_no", "account_code", "debit", "credit")
         values ($1, $2, $3, 1, 'FOLIO_GUEST', 10.0001, 0)`,
        [tenantA, property.id, journal.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const journal = await client.query(
      `insert into "journal"
         ("tenant_id", "property_id", "business_date", "currency", "source_type",
          "source_id", "total_debit", "total_credit")
       values ($1, $2, $3, 'IDR', 'SIDE_TEST', $4, 10, 10)
       returning "id"`,
      [tenantA, property.id, openedDate, randomUUID()],
    );
    await expect(
      client.query(
        `insert into "journal_line"
           ("tenant_id", "property_id", "journal_id", "line_no", "account_code", "debit", "credit")
         values ($1, $2, $3, 1, 'FOLIO_GUEST', 5, 5)`,
        [tenantA, property.id, journal.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
});

test('P08-01 a property keeps one active day and closed days never reopen', async () => {
  await withOwner(async (client) => {
    await insertDay(client, {
      tenantId: tenantB,
      propertyId: propertyB,
      date: '2026-09-10',
      state: 'OPEN',
    });
    await expect(
      insertDay(client, {
        tenantId: tenantB,
        propertyId: propertyB,
        date: '2026-09-11',
        state: 'OPEN',
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query(
      `update "business_day" set "state" = 'CLOSED', "closed_at" = now()
        where "tenant_id" = $1 and "property_id" = $2 and "business_date" = '2026-09-10'`,
      [tenantB, propertyB],
    );
    await insertDay(client, {
      tenantId: tenantB,
      propertyId: propertyB,
      date: '2026-09-11',
      state: 'OPEN',
    });
    await expect(
      client.query(
        `update "business_day" set "state" = 'OPEN', "closed_at" = null
          where "tenant_id" = $1 and "property_id" = $2 and "business_date" = '2026-09-10'`,
        [tenantB, propertyB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `update "business_day" set "business_date" = '2026-09-12'
          where "tenant_id" = $1 and "property_id" = $2 and "business_date" = '2026-09-11'`,
        [tenantB, propertyB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `update "business_day" set "version" = "version" + 1
          where "tenant_id" = $1 and "property_id" = $2 and "business_date" = '2026-09-11'`,
        [tenantB, propertyB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

test('P08-01 finance rows stay inside their tenant under RLS', async () => {
  const hidden = await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const result = await client.query(
      `select count(*)::int as "count" from "journal" where "id" = $1`,
      [journalId],
    );
    await client.query('rollback');
    return result.rows[0].count;
  });
  expect(hidden).toBe(0);
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    await expect(
      client.query(
        `insert into "business_day" ("tenant_id", "property_id", "business_date")
         values ($1, $2, '2026-10-01')`,
        [tenantB, property.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await client.query('rollback');
  });
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    await expect(
      client.query(
        `insert into "journal"
           ("tenant_id", "property_id", "business_date", "currency", "source_type",
            "total_debit", "total_credit")
         values ($1, $2, '2026-09-11', 'IDR', 'CROSS_TEST', 1, 1)`,
        [tenantB, property.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
});
