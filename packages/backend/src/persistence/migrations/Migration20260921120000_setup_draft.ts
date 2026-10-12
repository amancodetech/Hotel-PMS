import { Migration } from '@mikro-orm/migrations';

export class Migration20260921120000_setup_draft extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "property_limits_profile"
        add "max_setup_units_inline" integer not null default 20
    `);
    this.addSql(`
      alter table "property_limits_profile"
        add constraint "property_limits_profile_setup_units_check"
        check ("max_setup_units_inline" > 0)
    `);

    this.addSql(`
      create table "property_setup_draft" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "property_id" uuid not null,
        "revision" integer not null default 1,
        "input" jsonb not null,
        "completed" boolean not null default false,
        "updated_by_user_id" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "property_setup_draft_revision_check" check ("revision" >= 1),
        constraint "property_setup_draft_tenant_property_unique"
          unique ("tenant_id", "property_id"),
        constraint "property_setup_draft_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "property_setup_draft_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "property_setup_draft_property_idx" on "property_setup_draft" ("tenant_id", "property_id", "updated_at" desc)`,
    );

    this.addSql(`alter table "property_setup_draft" enable row level security`);
    this.addSql(`alter table "property_setup_draft" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "property_setup_draft"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "property_setup_draft"
      for each row execute function public.prevent_tenant_id_change()
    `);

    this.addSql(
      `grant select, insert, update, delete on "property_setup_draft" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "property_setup_draft" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "property_setup_draft"`);
    this.addSql(
      `alter table "property_limits_profile" drop constraint if exists "property_limits_profile_setup_units_check"`,
    );
    this.addSql(
      `alter table "property_limits_profile" drop column if exists "max_setup_units_inline"`,
    );
  }
}
