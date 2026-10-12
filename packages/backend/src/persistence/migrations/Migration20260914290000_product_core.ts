import { Migration } from '@mikro-orm/migrations';

export class Migration20260914290000_product_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "resource"
        add constraint "resource_scope_type_unique"
        unique ("id", "property_id", "tenant_id", "resource_type")
    `);

    this.addSql(`
      create table "inventory_pool" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "code" varchar(80) not null,
        "name" varchar(160) not null,
        "resource_type" varchar(16) not null references "resource_type" ("code") on delete restrict,
        "status" varchar(16) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "inventory_pool_status_check" check ("status" in ('ACTIVE', 'INACTIVE')),
        constraint "inventory_pool_property_code_unique" unique ("tenant_id", "property_id", "code"),
        constraint "inventory_pool_scope_type_unique" unique ("id", "property_id", "tenant_id", "resource_type"),
        constraint "inventory_pool_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);

    this.addSql(`
      create table "pool_member" (
        "pool_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_type" varchar(16) not null,
        "resource_id" uuid not null,
        "effective_from" date not null default current_date,
        "effective_to" date,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "pool_member_pk" primary key ("pool_id", "resource_id"),
        constraint "pool_member_period_check"
          check ("effective_to" is null or "effective_to" >= "effective_from"),
        constraint "pool_member_pool_fk"
          foreign key ("pool_id", "property_id", "tenant_id", "resource_type")
          references "inventory_pool" ("id", "property_id", "tenant_id", "resource_type")
          on delete cascade,
        constraint "pool_member_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id", "resource_type")
          references "resource" ("id", "property_id", "tenant_id", "resource_type")
          on delete restrict
      )
    `);

    this.addSql(`
      create table "product" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "code" varchar(80) not null,
        "name" varchar(160) not null,
        "kind" varchar(16) not null references "resource_type" ("code") on delete restrict,
        "occupancy_adults_min" integer not null default 1,
        "occupancy_adults_max" integer not null default 2,
        "occupancy_children_max" integer not null default 0,
        "meal_plan" varchar(32) not null default 'NONE',
        "pool_id" uuid,
        "status" varchar(16) not null default 'DRAFT',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "product_status_check" check ("status" in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
        constraint "product_meal_plan_check" check ("meal_plan" in ('NONE', 'BREAKFAST')),
        constraint "product_occupancy_check" check (
          "occupancy_adults_min" >= 0 and "occupancy_adults_min" <= 100
          and "occupancy_adults_max" >= 0 and "occupancy_adults_max" <= 100
          and "occupancy_adults_min" <= "occupancy_adults_max"
          and "occupancy_children_max" >= 0 and "occupancy_children_max" <= 100
        ),
        constraint "product_property_code_unique" unique ("tenant_id", "property_id", "code"),
        constraint "product_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "product_scope_kind_unique" unique ("id", "property_id", "tenant_id", "kind"),
        constraint "product_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade,
        constraint "product_pool_fk"
          foreign key ("pool_id", "property_id", "tenant_id", "kind")
          references "inventory_pool" ("id", "property_id", "tenant_id", "resource_type")
          on delete restrict
      )
    `);
    this.addSql(
      `create index "product_property_status_idx" on "product" ("tenant_id", "property_id", "status")`,
    );

    this.addSql(`
      create table "product_resource_candidate" (
        "product_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_type" varchar(16) not null,
        "resource_id" uuid not null,
        "created_at" timestamptz not null default now(),
        constraint "product_resource_candidate_pk" primary key ("product_id", "resource_id"),
        constraint "product_resource_candidate_product_fk"
          foreign key ("product_id", "property_id", "tenant_id", "resource_type")
          references "product" ("id", "property_id", "tenant_id", "kind")
          on delete cascade,
        constraint "product_resource_candidate_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id", "resource_type")
          references "resource" ("id", "property_id", "tenant_id", "resource_type")
          on delete restrict
      )
    `);

    for (const table of [
      'product',
      'inventory_pool',
      'pool_member',
      'product_resource_candidate',
    ]) {
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

    this.addSql(`
      grant select, insert, update, delete on
        "product", "inventory_pool", "pool_member", "product_resource_candidate"
      to "hotel_api"
    `);
    this.addSql(
      `grant select on "product", "inventory_pool", "pool_member", "product_resource_candidate" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "product", "inventory_pool", "pool_member", "product_resource_candidate"
      to "hotel_test"
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      revoke select, insert, update, delete on
        "product", "inventory_pool", "pool_member", "product_resource_candidate"
      from "hotel_api"
    `);
    this.addSql(
      `revoke select on "product", "inventory_pool", "pool_member", "product_resource_candidate" from "hotel_worker"`,
    );
    this.addSql(`
      revoke select, insert, update, delete on
        "product", "inventory_pool", "pool_member", "product_resource_candidate"
      from "hotel_test"
    `);
    for (const table of [
      'product',
      'inventory_pool',
      'pool_member',
      'product_resource_candidate',
    ]) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    }
    this.addSql(`drop table if exists "product_resource_candidate"`);
    this.addSql(`drop table if exists "product"`);
    this.addSql(`drop table if exists "pool_member"`);
    this.addSql(`drop table if exists "inventory_pool"`);
    this.addSql(
      `alter table "resource" drop constraint if exists "resource_scope_type_unique"`,
    );
  }
}
