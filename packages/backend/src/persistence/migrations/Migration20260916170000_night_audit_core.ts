import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'night_audit_run',
  'night_audit_step',
  'night_audit_exception',
  'night_audit_event',
];

/**
 * P10-01..P10-03 night audit ownership tables. The business day state machine
 * (business_day) is unchanged; the journal guard is replaced so the audit
 * preparation/validation states stay postable (the CLOSING barrier is the only
 * write barrier, per docs/08 and D-13) while CLOSED stays sealed.
 */
export class Migration20260916170000_night_audit_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "night_audit_run" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "business_date" date not null,
        "state" varchar(24) not null default 'PENDING',
        "current_step" varchar(40),
        "steps_total" integer not null default 0,
        "steps_done" integer not null default 0,
        "trigger_actor_kind" varchar(16) not null,
        "trigger_actor_id" uuid,
        "trigger_actor_label" text,
        "owner_membership_id" uuid,
        "attempt" integer not null default 0,
        "lease_owner" text,
        "lease_expires_at" timestamptz,
        "last_error_code" varchar(80),
        "last_error" jsonb,
        "result" jsonb,
        "correlation_id" text,
        "started_at" timestamptz,
        "finished_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "night_audit_run_state_check" check ("state" in (
          'PENDING', 'RUNNING', 'VALIDATION_FAILED', 'FAILED', 'SUCCEEDED'
        )),
        constraint "night_audit_run_actor_check"
          check ("trigger_actor_kind" in ('USER', 'SERVICE')),
        constraint "night_audit_run_attempt_check" check ("attempt" >= 0),
        constraint "night_audit_run_date_unique"
          unique ("tenant_id", "property_id", "business_date"),
        constraint "night_audit_run_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "night_audit_run_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict,
        constraint "night_audit_run_owner_fk"
          foreign key ("owner_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete set null
      )
    `);
    this.addSql(`
      create index "night_audit_run_work_idx"
        on "night_audit_run" ("state", "lease_expires_at")
    `);

    this.addSql(`
      create table "night_audit_step" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "run_id" uuid not null,
        "business_date" date not null,
        "step_key" varchar(40) not null,
        "step_order" integer not null,
        "state" varchar(16) not null default 'PENDING',
        "attempts" integer not null default 0,
        "checkpoint" jsonb,
        "last_error_code" varchar(80),
        "last_error" jsonb,
        "correlation_id" text,
        "started_at" timestamptz,
        "finished_at" timestamptz,
        "updated_at" timestamptz not null default now(),
        constraint "night_audit_step_state_check"
          check ("state" in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
        constraint "night_audit_step_order_check" check ("step_order" > 0),
        constraint "night_audit_step_attempts_check" check ("attempts" >= 0),
        constraint "night_audit_step_date_unique"
          unique ("tenant_id", "property_id", "business_date", "step_key"),
        constraint "night_audit_step_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "night_audit_step_run_fk"
          foreign key ("run_id", "property_id", "tenant_id")
          references "night_audit_run" ("id", "property_id", "tenant_id")
          on delete cascade
      )
    `);
    this.addSql(`
      create index "night_audit_step_run_idx"
        on "night_audit_step" ("run_id", "step_order")
    `);

    this.addSql(`
      create table "night_audit_exception" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "run_id" uuid not null,
        "business_date" date not null,
        "step_key" varchar(40) not null,
        "code" varchar(48) not null,
        "severity" varchar(12) not null default 'BLOCKING',
        "state" varchar(16) not null default 'OPEN',
        "subject_type" varchar(24) not null,
        "subject_id" uuid,
        "message" text not null,
        "details" jsonb not null default '{}'::jsonb,
        "owner_membership_id" uuid,
        "owner_label" text,
        "resolution_reason" text,
        "resolved_by" uuid,
        "resolved_at" timestamptz,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "night_audit_exception_severity_check"
          check ("severity" in ('BLOCKING', 'WARNING')),
        constraint "night_audit_exception_state_check"
          check ("state" in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
        constraint "night_audit_exception_resolution_check" check (
          ("state" = 'OPEN') = ("resolution_reason" is null)
        ),
        constraint "night_audit_exception_owner_check" check (
          "state" <> 'ACKNOWLEDGED'
          or "owner_membership_id" is not null
          or "owner_label" is not null
        ),
        constraint "night_audit_exception_unique"
          unique nulls not distinct (
            "tenant_id", "property_id", "run_id", "code", "subject_type", "subject_id"
          ),
        constraint "night_audit_exception_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "night_audit_exception_run_fk"
          foreign key ("run_id", "property_id", "tenant_id")
          references "night_audit_run" ("id", "property_id", "tenant_id")
          on delete cascade,
        constraint "night_audit_exception_owner_fk"
          foreign key ("owner_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete set null
      )
    `);
    this.addSql(`
      create index "night_audit_exception_run_idx"
        on "night_audit_exception" ("run_id", "state", "severity")
    `);

    this.addSql(`
      create table "night_audit_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "run_id" uuid not null,
        "business_date" date not null,
        "step_key" varchar(40),
        "level" varchar(12) not null default 'INFO',
        "event" varchar(64) not null,
        "message" text,
        "data" jsonb not null default '{}'::jsonb,
        "actor_kind" varchar(16) not null default 'SERVICE',
        "actor_id" uuid,
        "actor_label" text,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        constraint "night_audit_event_level_check"
          check ("level" in ('INFO', 'WARN', 'ERROR')),
        constraint "night_audit_event_actor_check"
          check ("actor_kind" in ('USER', 'SERVICE')),
        constraint "night_audit_event_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "night_audit_event_run_fk"
          foreign key ("run_id", "property_id", "tenant_id")
          references "night_audit_run" ("id", "property_id", "tenant_id")
          on delete cascade
      )
    `);
    this.addSql(`
      create index "night_audit_event_run_idx"
        on "night_audit_event" ("run_id", "created_at", "id")
    `);

    for (const table of tenantTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
          with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
      this.addSql(`
        create trigger "prevent_tenant_id_change"
        before update on "${table}"
        for each row execute function public.prevent_tenant_id_change()
      `);
    }

    // The CLOSING barrier is the only write barrier (docs/08/D-13): audit
    // preparation and validation remain postable so operators can resolve
    // balances before the day is sealed.
    this.addSql(`
      create or replace function public.assert_journal_postable()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        day_state varchar(20);
      begin
        if new."state" <> 'POSTED' then
          return new;
        end if;
        select "state" into day_state
          from "business_day"
         where "tenant_id" = new."tenant_id"
           and "property_id" = new."property_id"
           and "business_date" = new."business_date";
        if not found then
          raise exception 'no business day for %', new."business_date"
            using errcode = '23514';
        end if;
        if day_state not in ('OPEN', 'AUDIT_PREPARING', 'AUDIT_VALIDATION') then
          raise exception 'business day % is not open', new."business_date"
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);

    this.addSql(`
      create or replace function public.night_audit_work_tenants()
      returns table (tenant_id uuid)
      language sql
      security definer
      set search_path = public
      as $$
        select distinct r."tenant_id"
          from "night_audit_run" r
         where r."state" in ('PENDING', 'RUNNING')
           and (r."lease_expires_at" is null or r."lease_expires_at" <= now())
         limit 200
      $$
    `);
    this.addSql(
      `grant execute on function public.night_audit_work_tenants() to "hotel_worker"`,
    );
    this.addSql(
      `grant execute on function public.night_audit_work_tenants() to "hotel_test"`,
    );

    this.addSql(`
      grant select, insert, update on
        "night_audit_run", "night_audit_step", "night_audit_exception"
      to "hotel_api"
    `);
    this.addSql(`grant select, insert on "night_audit_event" to "hotel_api"`);

    this.addSql(`
      grant select, insert, update on
        "night_audit_run", "night_audit_step", "night_audit_exception"
      to "hotel_worker"
    `);
    this.addSql(
      `grant select, insert on "night_audit_event" to "hotel_worker"`,
    );
    // The worker executes the night audit: it may advance the day state, post
    // the one nightly charge per stay (journal/folio_charge inserts, never
    // update/delete of posted rows) and write its own audit trail.
    this.addSql(`grant update on "business_day" to "hotel_worker"`);
    this.addSql(`grant insert on "journal", "journal_line" to "hotel_worker"`);
    this.addSql(`grant insert on "folio_charge" to "hotel_worker"`);
    this.addSql(`grant insert on "audit_event" to "hotel_worker"`);

    this.addSql(`
      grant select, insert, update, delete on
        "night_audit_run", "night_audit_step", "night_audit_exception",
        "night_audit_event"
      to "hotel_test"
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      create or replace function public.assert_journal_postable()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        day_state varchar(20);
      begin
        if new."state" <> 'POSTED' then
          return new;
        end if;
        select "state" into day_state
          from "business_day"
         where "tenant_id" = new."tenant_id"
           and "property_id" = new."property_id"
           and "business_date" = new."business_date";
        if not found then
          raise exception 'no business day for %', new."business_date"
            using errcode = '23514';
        end if;
        if day_state <> 'OPEN' then
          raise exception 'business day % is not open', new."business_date"
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(
      `revoke select, insert, update, delete on
        "night_audit_run", "night_audit_step", "night_audit_exception",
        "night_audit_event"
      from "hotel_test"`,
    );
    this.addSql(`revoke insert on "audit_event" from "hotel_worker"`);
    this.addSql(`revoke insert on "folio_charge" from "hotel_worker"`);
    this.addSql(
      `revoke insert on "journal", "journal_line" from "hotel_worker"`,
    );
    this.addSql(`revoke update on "business_day" from "hotel_worker"`);
    this.addSql(
      `revoke select, insert, update on
        "night_audit_run", "night_audit_step", "night_audit_exception"
      from "hotel_worker"`,
    );
    this.addSql(
      `revoke select, insert on "night_audit_event" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select, insert, update on
        "night_audit_run", "night_audit_step", "night_audit_exception"
      from "hotel_api"`,
    );
    this.addSql(
      `revoke select, insert on "night_audit_event" from "hotel_api"`,
    );
    this.addSql(
      `revoke execute on function public.night_audit_work_tenants() from "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.night_audit_work_tenants() from "hotel_worker"`,
    );
    this.addSql(`drop function if exists public.night_audit_work_tenants()`);
    this.addSql(`drop table if exists "night_audit_event" cascade`);
    this.addSql(`drop table if exists "night_audit_exception" cascade`);
    this.addSql(`drop table if exists "night_audit_step" cascade`);
    this.addSql(`drop table if exists "night_audit_run" cascade`);
  }
}
