import { MikroORM } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';
import { ormOptions } from './orm-options.js';

export async function createOrm(
  clientUrl: string,
  overrides: Partial<Options> = {},
): Promise<MikroORM> {
  return MikroORM.init({ ...ormOptions(clientUrl), ...overrides });
}
