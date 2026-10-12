import { Migration } from '@mikro-orm/migrations';

/**
 * P12-02 customer lifecycle: tenant onboarding, suspension, reactivation and
 * closure that preserve commitments, the writer and channel state, without
 * giving platform staff tenant-data access. The lifecycle ledger is an
 * append-only platform table with aggregate safety snapshots (no tenant rows,
 * no guest data); the two tenant-affecting mutations (status and sales stop)
 * run through security-definer helpers that only accept active platform staff.
 */
export class Migration20260917030000_platform_customer_lifecycle extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "platform_subscription" add column "tenant_slug" varchar(64)`,
    );
    this.addSql(`
      update "platform_subscription" s
         set "tenant_slug" = t."slug"
        from "tenant" t
       where t."id" = s."tenant_id" and s."tenant_slug" is null
    `);
    this.addSql(
      `alter table "platform_subscription" alter column "tenant_slug" set not null`,
    );
    this.addSql(`
      create unique index "platform_subscription_slug_unique"
        on "platform_subscription" ("tenant_slug")
    `);

    this.addSql(`
      create table "platform_lifecycle_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete restrict,
        "subscription_id" uuid not null,
        "event_type" varchar(16) not null,
        "state_before" varchar(16),
        "state_after" varchar(16) not null,
        "reason" varchar(500),
        "idempotency_key" varchar(200) not null,
        "snapshot" jsonb not null default '{}'::jsonb,
        "actor_user_id" uuid,
        "actor_label" text,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "platform_lifecycle_event_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_lifecycle_event_key_unique"
          unique ("tenant_id", "idempotency_key"),
        constraint "platform_lifecycle_event_type_check" check (
          "event_type" in ('ONBOARDED', 'SUSPENDED', 'REACTIVATED', 'CLOSED')
        ),
        constraint "platform_lifecycle_event_state_check" check (
          "state_after" in ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED')
        ),
        constraint "platform_lifecycle_event_subscription_fk"
          foreign key ("subscription_id", "tenant_id")
          references "platform_subscription" ("id", "tenant_id")
          on delete restrict
      )
    `);
    this.addSql(`
      create index "platform_lifecycle_event_idx"
        on "platform_lifecycle_event" ("tenant_id", "created_at")
    `);

    this.addSql(
      `alter table "sale_restriction" add column "platform_stop" boolean not null default false`,
    );

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
        if not public.is_active_platform_staff(p_actor) then
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
          'commitments_active', (select count(*) from "commitment" where "tenant_id" = p_tenant and "state" in ('HELD', 'CONFIRMED', 'IN_USE')),
          'reservations_open', (select count(*) from "reservation" where "tenant_id" = p_tenant and "status" in ('DRAFT', 'CONFIRMED', 'IN_HOUSE', 'PARTIALLY_CHECKED_IN', 'PARTIALLY_CHECKED_OUT')),
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
        if not public.is_active_platform_staff(p_actor) then
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
        if not public.is_active_platform_staff(p_actor) then
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
        if not public.is_active_platform_staff(p_actor) then
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

    this.addSql(
      `alter table "platform_lifecycle_event" enable row level security`,
    );
    this.addSql(
      `alter table "platform_lifecycle_event" force row level security`,
    );
    this.addSql(`
      create policy "platform_access" on "platform_lifecycle_event"
        using (public.is_active_platform_staff(
          nullif(current_setting('app.platform_user_id', true), '')::uuid
        ))
        with check (public.is_active_platform_staff(
          nullif(current_setting('app.platform_user_id', true), '')::uuid
        ))
    `);
    this.addSql(`
      create policy "tenant_read" on "platform_lifecycle_event" for select
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "platform_lifecycle_event"
      for each row execute function public.prevent_tenant_id_change()
    `);
    this.addSql(`
      create trigger "platform_lifecycle_event_immutable"
      before update or delete on "platform_lifecycle_event"
      for each row execute function public.platform_policy_version_immutable()
    `);

    this.addSql(
      `grant execute on function public.platform_lifecycle_snapshot(uuid, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_lifecycle_snapshot(uuid, uuid) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_set_tenant_status(uuid, text, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_set_tenant_status(uuid, text, uuid) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_stop_tenant_sales(uuid, uuid, text) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_stop_tenant_sales(uuid, uuid, text) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_resume_tenant_sales(uuid, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_resume_tenant_sales(uuid, uuid) to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_lifecycle_event" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_lifecycle_event" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke select, insert, update, delete on "platform_lifecycle_event" from "hotel_test"`,
    );
    this.addSql(
      `revoke select, insert on "platform_lifecycle_event" from "hotel_api"`,
    );
    this.addSql(
      `revoke execute on function public.platform_resume_tenant_sales(uuid, uuid) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.platform_stop_tenant_sales(uuid, uuid, text) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.platform_set_tenant_status(uuid, text, uuid) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.platform_lifecycle_snapshot(uuid, uuid) from "hotel_api", "hotel_test"`,
    );
    this.addSql(`drop table if exists "platform_lifecycle_event" cascade`);
    this.addSql(
      `drop function if exists public.platform_resume_tenant_sales(uuid, uuid)`,
    );
    this.addSql(
      `drop function if exists public.platform_stop_tenant_sales(uuid, uuid, text)`,
    );
    this.addSql(
      `drop function if exists public.platform_set_tenant_status(uuid, text, uuid)`,
    );
    this.addSql(
      `drop function if exists public.platform_lifecycle_snapshot(uuid, uuid)`,
    );
    this.addSql(
      `alter table "sale_restriction" drop column if exists "platform_stop"`,
    );
    this.addSql(`drop index if exists "platform_subscription_slug_unique"`);
    this.addSql(
      `alter table "platform_subscription" drop column if exists "tenant_slug"`,
    );
  }
}
