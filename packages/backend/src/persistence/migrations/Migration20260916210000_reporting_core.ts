import { Migration } from '@mikro-orm/migrations';

const permissionCodes = [
  'report.operational.view',
  'report.financial.view',
  'report.export',
];

/**
 * P11-01 reporting core: an immutable pickup snapshot (one per tenant,
 * property, kind and reference date) plus the report permission catalog.
 * Reports themselves never write to operating records; the snapshot is the
 * only added write target and it is append-only for the API role.
 */
export class Migration20260916210000_reporting_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "report_snapshot" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "kind" varchar(24) not null default 'PICKUP',
        "reference_date" date not null,
        "data" jsonb not null,
        "source_summary" jsonb not null default '{}'::jsonb,
        "captured_by_membership_id" uuid,
        "captured_by_label" text,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        constraint "report_snapshot_kind_check" check ("kind" in ('PICKUP')),
        constraint "report_snapshot_reference_unique"
          unique ("tenant_id", "property_id", "kind", "reference_date"),
        constraint "report_snapshot_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "report_snapshot_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict,
        constraint "report_snapshot_membership_fk"
          foreign key ("captured_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete set null
      )
    `);

    this.addSql(`alter table "report_snapshot" enable row level security`);
    this.addSql(`alter table "report_snapshot" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "report_snapshot"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "report_snapshot"
      for each row execute function public.prevent_tenant_id_change()
    `);

    // API may append snapshots and read them back; there is no update/delete
    // grant, so a captured snapshot cannot be rewritten through the API role.
    this.addSql(`grant select, insert on "report_snapshot" to "hotel_api"`);
    this.addSql(
      `grant select, insert, update, delete on "report_snapshot" to "hotel_test"`,
    );

    const permissionValues = permissionCodes
      .map((code) => `('${code}', 'permissions.${code}')`)
      .join(', ');
    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ${permissionValues}
      on conflict ("code") do nothing
    `);
    const allList = permissionCodes.map((code) => `'${code}'`).join(', ');
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" in (${allList})
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p
          on p."code" in ('report.operational.view', 'report.financial.view')
       where r."is_system" = true
         and r."code" = 'AUDITOR'
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    const permissionList = permissionCodes
      .map((code) => `'${code}'`)
      .join(', ');
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in (${permissionList})
    `);
    this.addSql(`
      delete from "permission" where "code" in (${permissionList})
    `);
    this.addSql(
      `revoke select, insert, update, delete on "report_snapshot" from "hotel_test"`,
    );
    this.addSql(`revoke select, insert on "report_snapshot" from "hotel_api"`);
    this.addSql(
      `drop trigger if exists "prevent_tenant_id_change" on "report_snapshot"`,
    );
    this.addSql(`drop table if exists "report_snapshot" cascade`);
  }
}
