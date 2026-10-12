import { Migration } from '@mikro-orm/migrations';

const permissionCodes = ['maintenance.read', 'maintenance.manage'];

export class Migration20260916120000_operations_work_orders extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "ops_work_order" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "category" varchar(16) not null default 'GENERAL',
        "severity" varchar(16) not null default 'MEDIUM',
        "impact" varchar(8) not null default 'NONE',
        "emergency" boolean not null default false,
        "status" varchar(16) not null default 'OPEN',
        "description" text not null,
        "period_start" date,
        "period_end" date,
        "block_id" uuid,
        "assignee_membership_id" uuid,
        "resolution_note" text,
        "verified_at" timestamptz,
        "verified_by_membership_id" uuid,
        "closed_at" timestamptz,
        "reopen_count" integer not null default 0,
        "last_reopen_reason" text,
        "created_by_membership_id" uuid,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "ops_work_order_category_check"
          check ("category" in ('GENERAL', 'PLUMBING', 'ELECTRICAL', 'HVAC', 'SAFETY', 'OTHER')),
        constraint "ops_work_order_severity_check"
          check ("severity" in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        constraint "ops_work_order_impact_check"
          check ("impact" in ('NONE', 'OOS', 'OOO')),
        constraint "ops_work_order_status_check"
          check ("status" in ('OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'VERIFIED', 'CLOSED')),
        constraint "ops_work_order_period_check"
          check ("period_start" is null
                 or ("period_end" is not null and "period_end" > "period_start")),
        constraint "ops_work_order_emergency_check"
          check (not "emergency"
                 or ("impact" = 'OOO' and "period_start" is not null
                     and "block_id" is not null)),
        constraint "ops_work_order_reopen_check" check ("reopen_count" >= 0),
        constraint "ops_work_order_version_check" check ("version" >= 1),
        constraint "ops_work_order_closed_check"
          check (("status" = 'CLOSED') = ("closed_at" is not null)),
        constraint "ops_work_order_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "ops_work_order_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_work_order_block_fk"
          foreign key ("block_id", "property_id", "tenant_id")
          references "inventory_block" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_work_order_assignee_fk"
          foreign key ("assignee_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_work_order_verifier_fk"
          foreign key ("verified_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_work_order_creator_fk"
          foreign key ("created_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "ops_work_order_resource_idx"
        on "ops_work_order" ("tenant_id", "property_id", "resource_id", "status")
    `);
    this.addSql(`
      create index "ops_work_order_board_idx"
        on "ops_work_order" ("tenant_id", "property_id", "status", "severity")
    `);

    this.addSql(`alter table "ops_work_order" enable row level security`);
    this.addSql(`alter table "ops_work_order" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "ops_work_order"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "ops_work_order"
      for each row execute function public.prevent_tenant_id_change()
    `);

    this.addSql(
      `grant select, insert, update on "ops_work_order" to "hotel_api"`,
    );
    this.addSql(`grant select on "ops_work_order" to "hotel_worker"`);
    this.addSql(
      `grant select, insert, update, delete on "ops_work_order" to "hotel_test"`,
    );

    const permissionValues = permissionCodes
      .map((code) => `('${code}', 'permissions.${code}')`)
      .join(',\n        ');
    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ${permissionValues}
      on conflict ("code") do nothing
    `);
    const permissionList = permissionCodes
      .map((code) => `'${code}'`)
      .join(', ');
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" in (${permissionList})
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
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
      `revoke select, insert, update, delete on "ops_work_order" from "hotel_test"`,
    );
    this.addSql(`revoke select on "ops_work_order" from "hotel_worker"`);
    this.addSql(
      `revoke select, insert, update on "ops_work_order" from "hotel_api"`,
    );
    this.addSql(`drop table if exists "ops_work_order" cascade`);
  }
}
