import { Migration } from '@mikro-orm/migrations';

/**
 * P12-04 hardening (F-RVW12-03): platform security-definer helpers validated
 * the active platform actor passed as `p_actor` but did not bind it to the
 * authenticated session context (`app.platform_user_id`), so raw SQL under an
 * operating role could invoke them with any active platform staff id. Each
 * helper now requires the argument to equal the session's platform user, in
 * addition to the existing active-staff check. Applied migrations are left
 * untouched; down() is a no-op because the bound definition is the intended V1
 * shape (same policy as the snapshot fix).
 */
export class Migration20260917080000_platform_actor_binding extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function public.platform_lifecycle_snapshot(
        p_tenant uuid,
        p_actor uuid
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_snapshot jsonb;
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        select jsonb_build_object(
          'writer', 'PMS',
          'captured_at', now(),
          'properties', (select count(*) from "property" where "tenant_id" = p_tenant),
          'resources', (select count(*) from "resource" where "tenant_id" = p_tenant),
          'connections_total', (select count(*) from "distribution_connection" where "tenant_id" = p_tenant),
          'connections_active', (select count(*) from "distribution_connection" where "tenant_id" = p_tenant and "status" = 'ACTIVE'),
          'exposures_active', (select count(*) from "exposure" where "tenant_id" = p_tenant and "state" in ('RESERVED', 'PUBLISHING', 'ACTIVE', 'WITHDRAWING', 'RECONCILING')),
          'exposures_unknown', (select count(*) from "exposure" where "tenant_id" = p_tenant and "state" = 'UNKNOWN'),
          'commitments_active', (select count(*) from "commitment" where "tenant_id" = p_tenant and "state" in ('ACTIVE', 'CONVERTED')),
          'reservations_open', (select count(*) from "reservation" where "tenant_id" = p_tenant and "state" in ('INQUIRY', 'TENTATIVE', 'WAITLIST', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_HOUSE', 'PARTIALLY_IN_HOUSE')),
          'stays_in_house', (select count(*) from "stay_segment" where "tenant_id" = p_tenant and "state" = 'IN_HOUSE'),
          'journal_rows', (select count(*) from "journal" where "tenant_id" = p_tenant),
          'folios', (select count(*) from "folio" where "tenant_id" = p_tenant)
        ) into v_snapshot;
        return v_snapshot;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_set_tenant_status(
        p_tenant uuid,
        p_status text,
        p_actor uuid
      )
      returns text
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_before text;
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        if p_status not in ('ACTIVE', 'SUSPENDED', 'CLOSED') then
          raise exception 'platform_lifecycle_status_invalid' using errcode = '23514';
        end if;
        select "status" into v_before from "tenant" where "id" = p_tenant for update;
        if not found then
          raise exception 'platform_lifecycle_tenant_missing' using errcode = 'P0002';
        end if;
        if not (
          (p_status = 'SUSPENDED' and v_before = 'ACTIVE') or
          (p_status = 'ACTIVE' and v_before = 'SUSPENDED') or
          (p_status = 'CLOSED' and v_before in ('ACTIVE', 'SUSPENDED'))
        ) then
          raise exception 'platform_lifecycle_transition_invalid'
            using errcode = '23514', detail = v_before || '->' || p_status;
        end if;
        update "tenant" set "status" = p_status, "updated_at" = now()
         where "id" = p_tenant;
        return v_before;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_stop_tenant_sales(
        p_tenant uuid,
        p_actor uuid,
        p_reason text
      )
      returns integer
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_count integer;
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        insert into "sale_restriction" (
          "tenant_id", "property_id", "connection_id", "product_id",
          "start_date", "end_date", "reason", "state", "platform_stop"
        )
        select e."tenant_id", e."property_id", e."connection_id", e."product_id",
               greatest(e."start_date", current_date), e."end_date",
               left('platform suspension: ' || coalesce(p_reason, 'safety stop'), 1000),
               'ACTIVE', true
          from "exposure" e
         where e."tenant_id" = p_tenant
           and e."state" in ('RESERVED', 'PUBLISHING', 'ACTIVE', 'WITHDRAWING', 'RECONCILING', 'UNKNOWN')
           and e."end_date" > current_date
           and not exists (
             select 1 from "sale_restriction" r
              where r."tenant_id" = e."tenant_id"
                and r."connection_id" = e."connection_id"
                and r."product_id" = e."product_id"
                and r."state" = 'ACTIVE'
                and r."start_date" <= greatest(e."start_date", current_date)
                and r."end_date" >= e."end_date"
           );
        get diagnostics v_count = row_count;
        return v_count;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_resume_tenant_sales(
        p_tenant uuid,
        p_actor uuid
      )
      returns integer
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_count integer;
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        update "sale_restriction"
           set "state" = 'OPENED', "opened_at" = now(), "opened_by" = p_actor,
               "version" = "version" + 1, "updated_at" = now()
         where "tenant_id" = p_tenant and "state" = 'ACTIVE'
           and "platform_stop" = true;
        get diagnostics v_count = row_count;
        return v_count;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_create_tenant(
        p_id uuid,
        p_name text,
        p_slug text,
        p_actor uuid
      )
      returns uuid
      language plpgsql
      security definer
      set search_path = public
      as $$
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        if p_name is null or length(trim(p_name)) < 2 or length(p_name) > 200 then
          raise exception 'platform_tenant_name_invalid' using errcode = '23514';
        end if;
        if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
          raise exception 'platform_tenant_slug_invalid' using errcode = '23514';
        end if;
        insert into "tenant" ("id", "name", "slug", "status")
        values (p_id, trim(p_name), p_slug, 'ACTIVE');
        return p_id;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.platform_record_tenant_audit(
        p_tenant uuid,
        p_actor uuid,
        p_actor_label text,
        p_action text,
        p_resource_type text,
        p_resource_id uuid,
        p_outcome text,
        p_before jsonb,
        p_after jsonb,
        p_reason text,
        p_correlation uuid
      )
      returns uuid
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_id uuid;
      begin
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_audit_actor_denied' using errcode = '42501';
        end if;
        insert into "audit_event" (
          "tenant_id", "actor_type", "actor_id", "actor_label", "action",
          "resource_type", "resource_id", "outcome", "before_safe",
          "after_safe", "reason", "correlation_id"
        ) values (
          p_tenant, 'USER', p_actor, p_actor_label, p_action,
          p_resource_type, p_resource_id, p_outcome, p_before,
          p_after, p_reason, p_correlation
        )
        returning "id" into v_id;
        return v_id;
      end
      $$
    `);

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
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
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
        if p_actor is distinct from nullif(current_setting('app.platform_user_id', true), '')::uuid
           or not public.is_active_platform_staff(p_actor) then
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
  }

  override async down(): Promise<void> {
    // No-op: the session-bound definition is the intended V1 shape.
  }
}
