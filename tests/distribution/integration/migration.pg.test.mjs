import { afterAll, expect, test } from '@jest/globals';
import { Client } from 'pg';

const legacyUrl = process.env.TEST_LEGACY_DATABASE_URL;
const client = legacyUrl ? new Client({ connectionString: legacyUrl }) : null;

afterAll(async () => {
  await client?.end();
});

test('legacy database keeps synthetic data and gains channel tables', async () => {
  expect(client).not.toBeNull();
  await client.connect();
  const marker = await client.query(
    `select note from "synthetic_legacy_marker" where id = 1`,
  );
  expect(marker.rows[0]?.note).toBe('pre-migration-synthetic');
  const columns = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'distribution_%'`,
  );
  expect(columns.rowCount).toBeGreaterThanOrEqual(11);
});
