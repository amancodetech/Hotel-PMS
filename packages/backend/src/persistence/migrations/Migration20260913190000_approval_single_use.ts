import { Migration } from '@mikro-orm/migrations';

export class Migration20260913190000_approval_single_use extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "approval_request"
        add column "consumed_at" timestamptz,
        add column "consumed_by" uuid references "app_user" ("id") on delete set null,
        add column "consumed_resource_type" varchar(100),
        add column "consumed_resource_id" uuid,
        add constraint "approval_consumption_check" check (
          ("consumed_at" is null
            and "consumed_resource_type" is null
            and "consumed_resource_id" is null)
          or "consumed_at" is not null
        ),
        add constraint "approval_tenant_id_unique" unique ("id", "tenant_id")
    `);
    this.addSql(
      `create index "approval_consumed_idx" on "approval_request" ("tenant_id", "consumed_at")`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "approval_consumed_idx"`);
    this.addSql(`
      alter table "approval_request"
        drop constraint if exists "approval_tenant_id_unique",
        drop constraint if exists "approval_consumption_check",
        drop column if exists "consumed_resource_id",
        drop column if exists "consumed_resource_type",
        drop column if exists "consumed_by",
        drop column if exists "consumed_at"
    `);
  }
}
