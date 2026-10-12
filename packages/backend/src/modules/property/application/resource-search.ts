import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { one, rows } from '../../../persistence/sql.js';
import { PropertyError } from '../domain/errors.js';
import type { ResourceRow } from '../persistence/types.js';

export const resourceSearchOptions = z
  .object({
    q: z.string().trim().max(100).optional(),
    sort: z.enum(['code', 'label', 'capacity']).optional(),
    type: z
      .enum([
        'ROOM',
        'VILLA',
        'APARTMENT',
        'HOUSE',
        'BED',
        'SITE',
        'CABIN',
        'TENT',
      ])
      .optional(),
    min_capacity: z.number().int().min(1).max(100).optional(),
    bedrooms_count: z.number().int().min(0).max(100).optional(),
    bathrooms_count: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type ResourceSearchOptions = z.infer<typeof resourceSearchOptions>;
const cursorKey = randomBytes(32);
const cursorSchema = z
  .object({
    tenant: z.string().uuid(),
    property: z.string().uuid(),
    revision: z.string(),
    filter: z.string(),
    value: z.union([z.string(), z.number()]),
    id: z.string().uuid(),
  })
  .strict();
function encode(value: z.infer<typeof cursorSchema>) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `v2.${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
}
function decode(token: string) {
  try {
    const [prefix, payload, signature, extra] = token.split('.');
    if (prefix !== 'v2' || !payload || !signature || extra) throw Error();
    const expected = createHmac('sha256', cursorKey).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw Error();
    return cursorSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
  } catch {
    throw new PropertyError('INVALID_REQUEST', { field: 'cursor' });
  }
}
const literalPattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
export async function searchResourcePage(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: ResourceSearchOptions & { limit: number; cursor?: string | null },
) {
  const filters = resourceSearchOptions.parse(
    Object.fromEntries(
      Object.entries(options).filter(([k]) => k !== 'limit' && k !== 'cursor'),
    ),
  );
  const sort = filters.sort ?? 'code';
  const filter = JSON.stringify({ ...filters, q: filters.q ?? '', sort });
  const property = await one<{ inventory_version: string }>(
    em,
    'select inventory_version::text from property where tenant_id=? and id=? for share',
    [tenantId, propertyId],
  );
  if (!property) throw new PropertyError('NOT_FOUND');
  const after = options.cursor ? decode(options.cursor) : null;
  if (
    after &&
    (after.tenant !== tenantId ||
      after.property !== propertyId ||
      after.filter !== filter)
  )
    throw new PropertyError('INVALID_REQUEST', {
      field: 'cursor',
      reason: 'scope_mismatch',
    });
  if (after && after.revision !== property.inventory_version)
    throw new PropertyError('STALE_VERSION', {
      reason: 'resource_search_changed',
    });
  const column = {
    code: 'code',
    label: 'coalesce(display_label,code)',
    capacity: 'capacity',
  }[sort];
  const terms = ['tenant_id=?', 'property_id=?'];
  const params: unknown[] = [tenantId, propertyId];
  if (filters.q) {
    terms.push(
      "(code ilike ? escape '\\' or coalesce(display_label,'') ilike ? escape '\\' or coalesce(unit_details->>'notes','') ilike ? escape '\\')",
    );
    params.push(...Array(3).fill(literalPattern(filters.q)));
  }
  if (filters.type) {
    terms.push('resource_type=?');
    params.push(filters.type);
  }
  if (filters.min_capacity !== undefined) {
    terms.push('capacity>=?');
    params.push(filters.min_capacity);
  }
  for (const field of ['bedrooms_count', 'bathrooms_count'] as const)
    if (filters[field] !== undefined) {
      terms.push(`unit_details->>'${field}'=?`);
      params.push(String(filters[field]));
    }
  if (after) {
    terms.push(
      `(${column},id)>(?${sort === 'capacity' ? '::integer' : '::text'},?::uuid)`,
    );
    params.push(after.value, after.id);
  }
  params.push(options.limit + 1);
  const found = await rows<ResourceRow>(
    em,
    `select * from resource where ${terms.join(' and ')} order by ${column},id limit ?`,
    params,
  );
  const items = found.slice(0, options.limit),
    last = items.at(-1);
  return {
    items,
    next_cursor:
      found.length > options.limit && last
        ? encode({
            tenant: tenantId,
            property: propertyId,
            revision: property.inventory_version,
            filter,
            value:
              sort === 'capacity'
                ? last.capacity
                : sort === 'label'
                  ? (last.display_label ?? last.code)
                  : last.code,
            id: last.id,
          })
        : null,
  };
}
