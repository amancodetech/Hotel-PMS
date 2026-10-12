import { Migration } from '@mikro-orm/migrations';

/**
 * P11-03 short-lived private report exports. The row is created by the API
 * (PENDING), generated once by the reporting worker (READY with sanitized CSV
 * content), and downloadable only by its creator membership until it expires
 * or is revoked. Content is deleted on expiry/revocation.
 */
export class Migration20260916220000_report_export extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "report_export" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid,
        "kind" varchar(24) not null,
        "format" varchar(8) not null default 'CSV',
        "state" varchar(12) not null default 'PENDING',
        "request" jsonb not null,
        "content" text,
        "content_sha256" char(64),
        "row_count" integer,
        "byte_size" integer,
        "lease_owner" text,
        "lease_expires_at" timestamptz,
        "attempt" integer not null default 0,
        "last_error_code" varchar(80),
        "created_by_membership_id" uuid,
        "created_by_label" text,
        "created_by_session_id" uuid,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        "ready_at" timestamptz,
        "expires_at" timestamptz not null,
        "revoked_at" timestamptz,
        constraint "report_export_kind_check" check (
          "kind" in (
            'OCCUPANCY', 'ADR_REVPAR', 'ARRIVALS', 'DEPARTURES', 'PICKUP',
            'REVENUE', 'TAX', 'SETTLEMENTS', 'CHANNEL_PERFORMANCE', 'PORTFOLIO'
          )
        ),
        constraint "report_export_format_check" check ("format" in ('CSV')),
        constraint "report_export_state_check" check (
          "state" in ('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED')
        ),
        constraint "report_export_ready_check" check (
          ("state" = 'READY') = ("ready_at" is not null)
        ),
        constraint "report_export_attempt_check" check ("attempt" >= 0),
        constraint "report_export_scope_unique" unique ("id", "tenant_id"),
        constraint "report_export_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict,
        constraint "report_export_membership_fk"
          foreign key ("created_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete set null
      )
    `);
    this.addSql(`
      create index "report_export_work_idx"
        on "report_export" ("state", "lease_expires_at", "created_at")
    `);
    this.addSql(`
      create index "report_export_owner_idx"
        on "report_export" ("tenant_id", "property_id", "created_by_membership_id", "created_at")
    `);

    this.addSql(`alter table "report_export" enable row level security`);
    this.addSql(`alter table "report_export" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "report_export"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "report_export"
      for each row execute function public.prevent_tenant_id_change()
    `);

    this.addSql(`
      create or replace function public.report_export_work_tenants()
      returns table (tenant_id uuid)
      language sql
      security definer
      set search_path = public
      as $$
        select distinct e."tenant_id"
          from "report_export" e
         where e."state" = 'PENDING'
            or (e."state" = 'RUNNING' and e."lease_expires_at" < now())
         limit 50
      $$
    `);
    this.addSql(
      `grant execute on function public.report_export_work_tenants() to "hotel_worker"`,
    );
    this.addSql(
      `grant execute on function public.report_export_work_tenants() to "hotel_test"`,
    );

    this.addSql(
      `grant select, insert, update on "report_export" to "hotel_api"`,
    );
    this.addSql(`grant select, update on "report_export" to "hotel_worker"`);
    this.addSql(
      `grant select, insert, update, delete on "report_export" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke execute on function public.report_export_work_tenants() from "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.report_export_work_tenants() from "hotel_worker"`,
    );
    this.addSql(`drop function if exists public.report_export_work_tenants()`);
    this.addSql(
      `revoke select, insert, update, delete on "report_export" from "hotel_test"`,
    );
    this.addSql(`revoke select, update on "report_export" from "hotel_worker"`);
    this.addSql(
      `revoke select, insert, update on "report_export" from "hotel_api"`,
    );
    this.addSql(
      `drop trigger if exists "prevent_tenant_id_change" on "report_export"`,
    );
    this.addSql(`drop table if exists "report_export" cascade`);
  }
}
