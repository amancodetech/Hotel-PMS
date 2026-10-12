import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config.js';
import { ormOptions } from './orm-options.js';
import type { Options } from '@mikro-orm/postgresql';

const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
});
const options: Options = {
  ...ormOptions(config.DATABASE_URL),
  extensions: [Migrator],
  migrations: {
    path: fileURLToPath(new URL('./migrations', import.meta.url)),
    pathTs: fileURLToPath(
      new URL('../../src/persistence/migrations', import.meta.url),
    ),
    transactional: true,
    allOrNothing: true,
    safe: true,
    dropTables: false,
  },
};
export default options;
