import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['reservation_import_run', 'reservation_import_row'];

export class Migration20260915110000_reservation_import extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "reservation_import_run" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "source" varchar(16) not null,
        "mode" varchar(16) not null,
        "file_name" varchar(200) not null,
        "content_type" varchar(64) not null,
        "file_hash" char(64) not null,
        "external_id" varchar(120),
        "rows_total" integer not null default 0,
        "rows_accepted" integer not null default 0,
        "rows_rejected" integer not null default 0,
        "rows_duplicate" integer not null default 0,
        "report_safe" jsonb not null default '{}',
        "created_by" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "reservation_import_run_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade,
        constraint "reservation_import_run_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "reservation_import_run_source_check" check ("source" in ('UPLOAD','FEED')),
        constraint "reservation_import_run_mode_check" check ("mode" in ('DRY_RUN','APPLY')),
        constraint "reservation_import_run_hash_unique" unique ("tenant_id", "property_id", "file_hash")
      )
    `);
    this.addSql(`
      create table "reservation_import_row" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "run_id" uuid not null,
        "line_no" integer not null,
        "external_key" varchar(80),
        "status" varchar(16) not null,
        "error_code" varchar(64),
        "reservation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "reservation_import_row_run_fk"
          foreign key ("run_id", "property_id", "tenant_id")
          references "reservation_import_run" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "reservation_import_row_status_check"
          check ("status" in ('ACCEPTED','REJECTED','DUPLICATE')),
        constraint "reservation_import_row_line_unique" unique ("run_id", "line_no")
      )
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
    this.addSql(
      `grant select, insert, update on "reservation_import_run" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert on "reservation_import_row" to "hotel_api"`,
    );
    this.addSql(
      `grant select on "reservation_import_run", "reservation_import_row" to "hotel_worker"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "reservation_import_run", "reservation_import_row" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke all on "reservation_import_run", "reservation_import_row" from "hotel_api"`,
    );
    this.addSql(
      `revoke all on "reservation_import_run", "reservation_import_row" from "hotel_worker"`,
    );
    this.addSql(
      `revoke all on "reservation_import_run", "reservation_import_row" from "hotel_test"`,
    );
    for (const table of [...tenantTables].reverse())
      this.addSql(`drop table if exists "${table}" cascade`);
  }
}
