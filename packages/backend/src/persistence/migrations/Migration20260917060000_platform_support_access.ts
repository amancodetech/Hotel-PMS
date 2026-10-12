import { Migration } from '@mikro-orm/migrations';

/**
 * P12-03 temporary platform support access (SEC-006): tenant reads are only
 * possible through an explicit, justified, time-boxed grant. The two
 * security-definer helpers re-validate the active platform staff actor and the
 * live grant scope on every call, so a platform employee without a grant (or
 * with an expired/revoked one) cannot read the tenant row or its audit trail
 * even from raw SQL under the operating role.
 */
export class Migration20260917060000_platform_support_access extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function public.platform_support_tenant_profile(
        p_tenant uuid,
        p_actor uuid
      )
      returns table (
        id uuid,
        name text,
        slug text,
        status text,
        created_at timestamptz
      )
      language plpgsql
      security definer
      set search_path = public
      as $$
      begin
        if not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_support_actor_denied' using errcode = '42501';
        end if;
        if not exists (
          select 1 from "platform_support_grant" g
           where g."tenant_id" = p_tenant
             and g."platform_user_id" = p_actor
             and g."revoked_at" is null
             and g."starts_at" <= now()
             and g."expires_at" > now()
             and g."scopes" ? 'tenant.read'
        ) then
          raise exception 'platform_support_grant_denied' using errcode = '42501';
        end if;
        return query
          select t."id", t."name"::text, t."slug"::text, t."status"::text,
                 t."created_at"
            from "tenant" t
           where t."id" = p_tenant;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_support_tenant_audit(
        p_tenant uuid,
        p_actor uuid,
        p_limit int
      )
      returns table (
        id uuid,
        action text,
        resource_type text,
        resource_id uuid,
        outcome text,
        actor_label text,
        reason text,
        created_at timestamptz
      )
      language plpgsql
      security definer
      set search_path = public
      as $$
      begin
        if not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_support_actor_denied' using errcode = '42501';
        end if;
        if not exists (
          select 1 from "platform_support_grant" g
           where g."tenant_id" = p_tenant
             and g."platform_user_id" = p_actor
             and g."revoked_at" is null
             and g."starts_at" <= now()
             and g."expires_at" > now()
             and g."scopes" ? 'audit.read'
        ) then
          raise exception 'platform_support_grant_denied' using errcode = '42501';
        end if;
        return query
          select a."id", a."action"::text, a."resource_type"::text,
                 a."resource_id", a."outcome"::text, a."actor_label"::text,
                 a."reason"::text, a."created_at"
            from "audit_event" a
           where a."tenant_id" = p_tenant
           order by a."created_at" desc, a."id" desc
           limit least(greatest(coalesce(p_limit, 50), 1), 200);
      end
      $$
    `);

    this.addSql(
      `grant execute on function public.platform_support_tenant_profile(uuid, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_support_tenant_profile(uuid, uuid) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_support_tenant_audit(uuid, uuid, int) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_support_tenant_audit(uuid, uuid, int) to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke execute on function public.platform_support_tenant_profile(uuid, uuid) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.platform_support_tenant_audit(uuid, uuid, int) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `drop function if exists public.platform_support_tenant_profile(uuid, uuid)`,
    );
    this.addSql(
      `drop function if exists public.platform_support_tenant_audit(uuid, uuid, int)`,
    );
  }
}
