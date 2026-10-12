import { Client } from 'pg';
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

const env = (() => {
  try {
    return { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
  } catch {
    return process.env;
  }
})();

const ownerUrl = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
if (!ownerUrl)
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL required');

const roles = [
  ['hotel_api', env.HOTEL_API_DB_PASSWORD],
  ['hotel_worker', env.HOTEL_WORKER_DB_PASSWORD],
  ['hotel_test', env.HOTEL_TEST_DB_PASSWORD],
];
for (const [name, password] of roles)
  if (!password || password.length < 12)
    throw new Error(
      `Missing generated password for ${name}; run pnpm env:init`,
    );

const client = new Client({ connectionString: ownerUrl });
await client.connect();
try {
  for (const [name, password] of roles) {
    await client.query(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${name}') then
           create role "${name}" nologin;
         end if;
       end $$`,
    );
    const formatted = await client.query(
      `select format(
         'alter role %I login password %L nosuperuser nocreatedb nocreaterole nobypassrls',
         $1::text, $2::text
       ) as sql`,
      [name, password],
    );
    await client.query(formatted.rows[0].sql);
  }
  console.log(
    `Local runtime database roles ready: ${roles.map(([name]) => name).join(', ')}. No credentials printed.`,
  );
} finally {
  await client.end();
}
