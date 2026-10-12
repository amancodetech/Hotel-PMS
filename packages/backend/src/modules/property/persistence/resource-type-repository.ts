import type { EntityManager } from '@mikro-orm/postgresql';
import { rows } from '../../../persistence/sql.js';
import type { ResourceTypeRow } from './types.js';

export async function listResourceTypes(
  em: EntityManager,
): Promise<ResourceTypeRow[]> {
  return rows<ResourceTypeRow>(
    em,
    `select "code", "name_key", "sort_order"
       from "resource_type"
      order by "sort_order"`,
  );
}
