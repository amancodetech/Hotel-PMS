import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { one, rows } from '../../../persistence/sql.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { PropertyError } from '../domain/errors.js';
import type { LocationRow, LocationKind } from '../persistence/types.js';
import { authorize, type ServiceContext } from './context.js';

// Cursors are short-lived navigation tokens, invalidated on API restart.
const cursorKey = randomBytes(32);
const cursorSchema = z
  .object({
    tenant: z.string().uuid(),
    property: z.string().uuid(),
    parent: z.string().uuid().nullable(),
    revision: z.string().regex(/^\d+$/),
    order: z.number().int().nonnegative(),
    code: z.string().max(80),
    id: z.string().uuid(),
    name: z.string().max(200).optional(),
    filter: z.string().optional(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
function encode(value: Cursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
}
function decode(token: string): Cursor {
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac('sha256', cursorKey).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    return cursorSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
  } catch {
    throw new PropertyError('INVALID_REQUEST', { field: 'cursor' });
  }
}

export async function locationAncestors(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  id: string,
): Promise<LocationRow[]> {
  return rows<LocationRow>(
    em,
    `with recursive ancestors as (
    select l.*,1 as depth,array[id] as visited from location l where tenant_id=? and property_id=? and id=?
    union all select l.*,a.depth+1,a.visited || l.id from location l join ancestors a on l.id=a.parent_id
      where l.tenant_id=? and l.property_id=? and a.depth<32 and not l.id=any(a.visited)
    ) select * from ancestors order by depth desc`,
    [tenantId, propertyId, id, tenantId, propertyId],
  );
}

export async function assertActiveLocation(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  id: string,
): Promise<void> {
  const ancestors = await locationAncestors(em, tenantId, propertyId, id);
  if (!ancestors.length) throw new PropertyError('CROSS_SCOPE_REFERENCE');
  if (ancestors.some((l) => l.status !== 'ACTIVE'))
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      reason: 'location_inactive',
    });
}

export async function assertLocationMove(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  id: string | null,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  await assertActiveLocation(em, tenantId, propertyId, parentId);
  if (
    id &&
    (await locationAncestors(em, tenantId, propertyId, parentId)).some(
      (l) => l.id === id,
    )
  )
    throw new PropertyError('INVALID_REQUEST', { reason: 'location_cycle' });
}

export async function readLocationTree(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  options: {
    parent_id?: string | null;
    limit?: number;
    cursor?: string;
    q?: string;
    kind?: LocationKind;
    sort?: 'display_order' | 'code' | 'name';
  },
): Promise<{
  items: LocationRow[];
  ancestors: LocationRow[];
  next_cursor: string | null;
}> {
  const parent = options.parent_id ?? null;
  const limit = options.limit ?? 50;
  const sort = options.sort ?? 'display_order';
  const q = options.q?.trim() ?? '';
  if (q.length > 100 || !['display_order', 'code', 'name'].includes(sort))
    throw new PropertyError('INVALID_REQUEST', { field: 'q' });
  const filter = JSON.stringify({ q, kind: options.kind ?? null, sort });
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      // SHARE stabilizes revision, ancestors and child page without serializing concurrent readers.
      const property = await one<{ location_tree_revision: string }>(
        em,
        `select location_tree_revision::text from property where tenant_id=? and id=? for share`,
        [context.tenantId, propertyId],
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const revision = property.location_tree_revision;
      const after = options.cursor ? decode(options.cursor) : null;
      if (
        after &&
        (after.tenant !== context.tenantId ||
          after.property !== propertyId ||
          after.parent !== parent ||
          (after.filter ??
            JSON.stringify({ q: '', kind: null, sort: 'display_order' })) !==
            filter)
      )
        throw new PropertyError('INVALID_REQUEST', {
          field: 'cursor',
          reason: 'scope_mismatch',
        });
      if (after && after.revision !== revision)
        throw new PropertyError('STALE_VERSION', {
          reason: 'location_tree_changed',
        });
      const ancestors = parent
        ? await locationAncestors(em, context.tenantId, propertyId, parent)
        : [];
      if (parent && !ancestors.length)
        throw new PropertyError('CROSS_SCOPE_REFERENCE');
      const terms = [
        'tenant_id=?',
        'property_id=?',
        parent === null ? 'parent_id is null' : 'parent_id=?::uuid',
      ];
      const params: unknown[] = [
        context.tenantId,
        propertyId,
        ...(parent === null ? [] : [parent]),
      ];
      if (q) {
        terms.push("(code ilike ? escape '\\' or name ilike ? escape '\\')");
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        params.push(pattern, pattern);
      }
      if (options.kind) {
        terms.push('kind=?');
        params.push(options.kind);
      }
      const columns = {
        display_order: 'display_order,code,id',
        code: 'code,id',
        name: 'name,code,id',
      }[sort];
      if (after) {
        if (sort === 'name' && after.name === undefined)
          throw new PropertyError('INVALID_REQUEST', { field: 'cursor' });
        terms.push(
          sort === 'display_order'
            ? '(display_order,code,id)>(?,?,?::uuid)'
            : sort === 'name'
              ? '(name,code,id)>(?,?,?::uuid)'
              : '(code,id)>(?,?::uuid)',
        );
        params.push(
          ...(sort === 'display_order'
            ? [after.order, after.code, after.id]
            : sort === 'name'
              ? [after.name, after.code, after.id]
              : [after.code, after.id]),
        );
      }
      params.push(limit + 1);
      const items = await rows<LocationRow>(
        em,
        `select * from location where ${terms.join(' and ')} order by ${columns} limit ?`,
        params,
      );
      const page = items.slice(0, limit),
        last = page.at(-1);
      return {
        items: page,
        ancestors,
        next_cursor:
          items.length > limit && last
            ? encode({
                tenant: context.tenantId,
                property: propertyId,
                parent,
                revision,
                order: last.display_order,
                code: last.code,
                id: last.id,
                name: last.name,
                filter,
              })
            : null,
      };
    },
  );
}
