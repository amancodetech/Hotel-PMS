import { defineConfig } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';

export function ormOptions(clientUrl: string): Options {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    debug: false,
    logger: () => undefined,
    pool: { min: 0, max: 10 },
    driverOptions: {
      connectionTimeoutMillis: 1500,
      statement_timeout: 1500,
      query_timeout: 3000,
    },
  });
}
