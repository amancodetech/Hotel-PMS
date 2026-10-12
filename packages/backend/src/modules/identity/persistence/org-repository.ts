import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type {
  EffectivePermissionRow,
  MembershipRow,
  MembershipViewRow,
  RoleGrantRow,
  RoleRow,
  TenantRow,
} from './types.js';

export async function insertTenant(
  em: EntityManager,
  input: { id?: string; name: string; slug: string },
): Promise<TenantRow> {
  const row = await one<TenantRow>(
    em,
    `insert into "tenant" ("id", "name", "slug") values (?, ?, ?) returning *`,
    [input.id ?? randomUUID(), input.name, input.slug],
  );
  if (!row) throw new Error('Tenant insert returned no row');
  return row;
}

export async function findTenantById(
  em: EntityManager,
  id: string,
): Promise<TenantRow | null> {
  return one<TenantRow>(em, `select * from "tenant" where "id" = ?`, [id]);
}

export async function findTenantBySlug(
  em: EntityManager,
  slug: string,
): Promise<TenantRow | null> {
  return one<TenantRow>(em, `select * from "tenant" where "slug" = ?`, [slug]);
}

export async function listTenantsForUser(
  em: EntityManager,
  userId: string,
): Promise<MembershipViewRow[]> {
  return rows<MembershipViewRow>(
    em,
    `select m.*, t."name" as "tenant_name", t."slug" as "tenant_slug",
            t."status" as "tenant_status",
            u."email" as "user_email", u."display_name" as "user_display_name"
       from "membership" m
       join "tenant" t on t."id" = m."tenant_id"
       join "app_user" u on u."id" = m."user_id"
      where m."user_id" = ?
      order by t."name"`,
    [userId],
  );
}

export async function insertMembership(
  em: EntityManager,
  input: {
    tenantId: string;
    userId: string;
    status: 'INVITED' | 'ACTIVE';
    joinedAt?: string | null;
  },
): Promise<MembershipRow> {
  const row = await one<MembershipRow>(
    em,
    `insert into "membership" ("id", "tenant_id", "user_id", "status", "joined_at")
     values (?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.userId,
      input.status,
      input.joinedAt ??
        (input.status === 'ACTIVE' ? new Date().toISOString() : null),
    ],
  );
  if (!row) throw new Error('Membership insert returned no row');
  return row;
}

export async function findMembership(
  em: EntityManager,
  tenantId: string,
  userId: string,
): Promise<MembershipRow | null> {
  return one<MembershipRow>(
    em,
    `select * from "membership" where "tenant_id" = ? and "user_id" = ?`,
    [tenantId, userId],
  );
}

export async function findMembershipById(
  em: EntityManager,
  tenantId: string,
  membershipId: string,
): Promise<MembershipRow | null> {
  return one<MembershipRow>(
    em,
    `select * from "membership" where "tenant_id" = ? and "id" = ?`,
    [tenantId, membershipId],
  );
}

export async function listMemberships(
  em: EntityManager,
  tenantId: string,
): Promise<MembershipViewRow[]> {
  return rows<MembershipViewRow>(
    em,
    `select m.*, t."name" as "tenant_name", t."slug" as "tenant_slug",
            t."status" as "tenant_status",
            u."email" as "user_email", u."display_name" as "user_display_name"
       from "membership" m
       join "tenant" t on t."id" = m."tenant_id"
       join "app_user" u on u."id" = m."user_id"
      where m."tenant_id" = ?
      order by u."display_name" nulls last, u."email"`,
    [tenantId],
  );
}

export async function updateMembershipStatus(
  em: EntityManager,
  tenantId: string,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
): Promise<MembershipRow | null> {
  return one<MembershipRow>(
    em,
    `update "membership"
        set "status" = ?,
            "revoked_at" = case when ? = 'REVOKED' then now() else null end,
            "joined_at" = case
              when ? = 'ACTIVE' then coalesce("joined_at", now())
              else "joined_at"
            end,
            "authz_version" = "authz_version" + 1,
            "updated_at" = now()
      where "tenant_id" = ? and "id" = ?
      returning *`,
    [status, status, status, tenantId, membershipId],
  );
}

export async function countActiveAdmins(
  em: EntityManager,
  tenantId: string,
  excludeMembershipId: string | null = null,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(distinct m."id")::int as "count"
       from "membership" m
      where m."tenant_id" = ?
        and m."status" = 'ACTIVE'
        and (?::uuid is null or m."id" <> ?::uuid)
        and exists (
          select 1
            from "role_grant" g
            join "role" r on r."id" = g."role_id" and r."tenant_id" = g."tenant_id"
            join "role_permission" rp on rp."role_id" = r."id"
           where g."tenant_id" = m."tenant_id"
             and g."membership_id" = m."id"
             and g."effect" = 'GRANT'
             and g."scope_type" = 'TENANT'
             and g."revoked_at" is null
             and (g."expires_at" is null or g."expires_at" > now())
             and r."status" = 'ACTIVE'
             and rp."permission_code" = 'role.grant'
        )
        and not exists (
          select 1
            from "role_grant" d
            join "role" dr on dr."id" = d."role_id" and dr."tenant_id" = d."tenant_id"
            join "role_permission" drp on drp."role_id" = dr."id"
           where d."tenant_id" = m."tenant_id"
             and d."membership_id" = m."id"
             and d."effect" = 'DENY'
             and d."scope_type" = 'TENANT'
             and d."revoked_at" is null
             and (d."expires_at" is null or d."expires_at" > now())
             and dr."status" = 'ACTIVE'
             and drp."permission_code" = 'role.grant'
        )`,
    [tenantId, excludeMembershipId, excludeMembershipId],
  );
  return row?.count ?? 0;
}

export async function lockTenantAuthz(
  em: EntityManager,
  tenantId: string,
): Promise<void> {
  await em.execute(
    `select pg_advisory_xact_lock(hashtextextended('hotel:authz:' || ?, 0))`,
    [tenantId],
  );
}

export async function revokeActiveGrantsForMembership(
  em: EntityManager,
  tenantId: string,
  membershipId: string,
): Promise<number> {
  const result = (await em.execute(
    `update "role_grant"
        set "revoked_at" = now(), "version" = "version" + 1, "updated_at" = now()
      where "tenant_id" = ? and "membership_id" = ? and "revoked_at" is null`,
    [tenantId, membershipId] as never[],
  )) as { affectedRows?: number };
  return result.affectedRows ?? 0;
}

export interface InsertRoleInput {
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  isSystem?: boolean;
  permissions?: string[];
}

export async function insertRole(
  em: EntityManager,
  input: InsertRoleInput,
): Promise<RoleRow> {
  const row = await one<RoleRow>(
    em,
    `insert into "role" ("id", "tenant_id", "code", "name", "description", "is_system")
     values (?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.code,
      input.name,
      input.description,
      input.isSystem ?? false,
    ],
  );
  if (!row) throw new Error('Role insert returned no row');
  if (input.permissions?.length)
    await replaceRolePermissions(em, row.id, input.permissions);
  return row;
}

export async function findRoleByCode(
  em: EntityManager,
  tenantId: string,
  code: string,
): Promise<RoleRow | null> {
  return one<RoleRow>(
    em,
    `select * from "role" where "tenant_id" = ? and "code" = ?`,
    [tenantId, code],
  );
}

export async function findRoleById(
  em: EntityManager,
  tenantId: string,
  roleId: string,
): Promise<RoleRow | null> {
  return one<RoleRow>(
    em,
    `select * from "role" where "tenant_id" = ? and "id" = ?`,
    [tenantId, roleId],
  );
}

export async function listRoles(
  em: EntityManager,
  tenantId: string,
): Promise<Array<RoleRow & { permission_codes: string[] }>> {
  const roleRows = await rows<RoleRow & { permission_codes: string[] | null }>(
    em,
    `select r.*,
            coalesce(
              array_agg(rp."permission_code" order by rp."permission_code")
                filter (where rp."permission_code" is not null),
              '{}'
            ) as "permission_codes"
       from "role" r
       left join "role_permission" rp on rp."role_id" = r."id"
      where r."tenant_id" = ?
      group by r."id"
      order by r."is_system" desc, r."code"`,
    [tenantId],
  );
  return roleRows.map((row) => ({
    ...row,
    permission_codes: row.permission_codes ?? [],
  }));
}

export async function updateRole(
  em: EntityManager,
  tenantId: string,
  roleId: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: 'ACTIVE' | 'RETIRED';
  },
): Promise<RoleRow | null> {
  return one<RoleRow>(
    em,
    `update "role"
        set "name" = coalesce(?, "name"),
            "description" = coalesce(?, "description"),
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "tenant_id" = ? and "id" = ?
      returning *`,
    [
      patch.name ?? null,
      patch.description ?? null,
      patch.status ?? null,
      tenantId,
      roleId,
    ],
  );
}

export async function deleteRole(
  em: EntityManager,
  tenantId: string,
  roleId: string,
): Promise<boolean> {
  const result = (await em.execute(
    `delete from "role" where "tenant_id" = ? and "id" = ? and "is_system" = false`,
    [tenantId, roleId] as never[],
  )) as { affectedRows?: number };
  return (result.affectedRows ?? 0) > 0;
}

export async function replaceRolePermissions(
  em: EntityManager,
  roleId: string,
  permissionCodes: string[],
): Promise<void> {
  await em.execute(`delete from "role_permission" where "role_id" = ?`, [
    roleId,
  ] as never[]);
  for (const code of [...new Set(permissionCodes)]
    .filter((value) => /^[a-z][a-z0-9._-]{2,99}$/.test(value))
    .sort()) {
    await em.execute(
      `insert into "role_permission" ("role_id", "permission_code")
       values (?, ?) on conflict do nothing`,
      [roleId, code] as never[],
    );
  }
}

export interface InsertGrantInput {
  tenantId: string;
  membershipId: string;
  roleId: string;
  effect?: 'GRANT' | 'DENY';
  scopeType: 'TENANT' | 'PROPERTIES';
  propertyRefs?: string[];
  grantedBy: string | null;
  reason: string | null;
  expiresAt?: string | null;
}

export async function insertGrant(
  em: EntityManager,
  input: InsertGrantInput,
): Promise<RoleGrantRow> {
  const row = await one<RoleGrantRow>(
    em,
    `insert into "role_grant"
       ("id", "tenant_id", "membership_id", "role_id", "effect", "scope_type",
        "granted_by", "reason", "expires_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.membershipId,
      input.roleId,
      input.effect ?? 'GRANT',
      input.scopeType,
      input.grantedBy,
      input.reason,
      input.expiresAt ?? null,
    ],
  );
  if (!row) throw new Error('Grant insert returned no row');
  for (const propertyRef of new Set(input.propertyRefs ?? []))
    await em.execute(
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values (?, ?, ?) on conflict do nothing`,
      [row.id, row.tenant_id, propertyRef] as never[],
    );
  return row;
}

export async function findGrantById(
  em: EntityManager,
  tenantId: string,
  grantId: string,
): Promise<RoleGrantRow | null> {
  return one<RoleGrantRow>(
    em,
    `select * from "role_grant" where "tenant_id" = ? and "id" = ?`,
    [tenantId, grantId],
  );
}

export async function listGrants(
  em: EntityManager,
  tenantId: string,
  membershipId: string | null = null,
): Promise<
  Array<
    RoleGrantRow & {
      role_code: string;
      role_name: string;
      property_refs: string[] | null;
      granted_by_email: string | null;
    }
  >
> {
  const grantRows = await rows<
    RoleGrantRow & {
      role_code: string;
      role_name: string;
      property_refs: string[] | null;
      granted_by_email: string | null;
    }
  >(
    em,
    `select g.*, r."code" as "role_code", r."name" as "role_name",
            u."email" as "granted_by_email",
            array_agg(gp."property_ref" order by gp."property_ref")
              filter (where gp."property_ref" is not null) as "property_refs"
       from "role_grant" g
       join "role" r on r."id" = g."role_id" and r."tenant_id" = g."tenant_id"
       left join "grant_property" gp on gp."grant_id" = g."id"
       left join "app_user" u on u."id" = g."granted_by"
      where g."tenant_id" = ?
        and (?::uuid is null or g."membership_id" = ?::uuid)
      group by g."id", r."code", r."name", u."email"
      order by g."created_at" desc`,
    [tenantId, membershipId, membershipId],
  );
  return grantRows.map((row) => ({
    ...row,
    property_refs: row.property_refs ?? [],
  }));
}

export async function revokeGrant(
  em: EntityManager,
  tenantId: string,
  grantId: string,
): Promise<RoleGrantRow | null> {
  return one<RoleGrantRow>(
    em,
    `update "role_grant"
        set "revoked_at" = now(), "version" = "version" + 1, "updated_at" = now()
      where "tenant_id" = ? and "id" = ? and "revoked_at" is null
      returning *`,
    [tenantId, grantId],
  );
}

export async function effectivePermissions(
  em: EntityManager,
  membershipId: string,
): Promise<EffectivePermissionRow[]> {
  return rows<EffectivePermissionRow>(
    em,
    `select rp."permission_code" as "permission_code",
            g."effect" as "effect",
            g."scope_type" as "scope_type",
            gp."property_ref" as "property_ref",
            g."id" as "grant_id",
            g."expires_at" as "expires_at"
       from "role_grant" g
       join "role" r
         on r."id" = g."role_id" and r."tenant_id" = g."tenant_id"
        and r."status" = 'ACTIVE'
       join "role_permission" rp on rp."role_id" = r."id"
       left join "grant_property" gp on gp."grant_id" = g."id"
      where g."membership_id" = ?
        and g."revoked_at" is null
        and (g."expires_at" is null or g."expires_at" > now())`,
    [membershipId],
  );
}

export async function roleCodesForMembership(
  em: EntityManager,
  membershipId: string,
): Promise<string[]> {
  const roleRows = await rows<{ code: string }>(
    em,
    `select distinct r."code" as "code"
       from "role_grant" g
       join "role" r on r."id" = g."role_id" and r."tenant_id" = g."tenant_id"
      where g."membership_id" = ?
        and g."effect" = 'GRANT'
        and g."revoked_at" is null
        and (g."expires_at" is null or g."expires_at" > now())
      order by r."code"`,
    [membershipId],
  );
  return roleRows.map((row) => row.code);
}

export function serializeScopeRefs(scopeRefs: string[]): string {
  return toJson(scopeRefs);
}
