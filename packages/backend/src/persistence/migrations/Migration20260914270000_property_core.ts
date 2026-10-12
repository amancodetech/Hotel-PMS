import { Migration } from '@mikro-orm/migrations';

export class Migration20260914270000_property_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "property_limits_profile" (
        "id" uuid primary key default gen_random_uuid(),
        "code" varchar(40) not null,
        "max_resources" integer not null,
        "max_composition_depth" integer not null,
        "max_leaves_per_product" integer not null,
        "max_items_per_request" integer not null,
        "horizon_nights" integer not null,
        "max_stay_nights" integer not null,
        "search_budget_ms" integer not null,
        "lock_wait_ms" integer not null,
        "retry_limit" integer not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "property_limits_profile_code_unique" unique ("code")
      )
    `);

    this.addSql(`
      create table "resource_type" (
        "code" varchar(16) primary key,
        "name_key" varchar(100) not null,
        "sort_order" integer not null
      )
    `);

    this.addSql(`
      create table "property_group" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "code" varchar(40) not null,
        "name" varchar(160) not null,
        "status" varchar(16) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "property_group_status_check" check ("status" in ('ACTIVE', 'ARCHIVED')),
        constraint "property_group_tenant_code_unique" unique ("tenant_id", "code"),
        constraint "property_group_tenant_id_unique" unique ("id", "tenant_id")
      )
    `);

    this.addSql(`
      create table "property" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "group_id" uuid,
        "code" varchar(40) not null,
        "name" varchar(160) not null,
        "timezone" varchar(64) not null,
        "base_currency" char(3) not null default 'IDR',
        "status" varchar(16) not null default 'SETUP',
        "limits_profile_id" uuid not null default '00000000-0000-4000-8000-000000000001'
          references "property_limits_profile" ("id") on delete restrict,
        "inventory_version" integer not null default 1,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "property_status_check" check ("status" in ('SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')),
        constraint "property_timezone_check" check ("timezone" in ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
        constraint "property_currency_check" check ("base_currency" in ('IDR', 'USD')),
        constraint "property_inventory_version_check" check ("inventory_version" >= 1),
        constraint "property_tenant_code_unique" unique ("tenant_id", "code"),
        constraint "property_tenant_id_unique" unique ("id", "tenant_id"),
        constraint "property_group_fk"
          foreign key ("group_id", "tenant_id")
          references "property_group" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "property_tenant_status_idx" on "property" ("tenant_id", "status")`,
    );

    this.addSql(`
      create table "location" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "code" varchar(40) not null,
        "name" varchar(160) not null,
        "status" varchar(16) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "location_status_check" check ("status" in ('ACTIVE', 'INACTIVE')),
        constraint "location_property_code_unique" unique ("tenant_id", "property_id", "code"),
        constraint "location_property_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "location_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);

    this.addSql(`
      create table "resource" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "code" varchar(80) not null,
        "resource_type" varchar(16) not null references "resource_type" ("code") on delete restrict,
        "capacity" integer not null,
        "location_id" uuid,
        "state" varchar(16) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "resource_state_check" check ("state" in ('ACTIVE', 'INACTIVE', 'RETIRED')),
        constraint "resource_capacity_check" check ("capacity" >= 1 and "capacity" <= 100),
        constraint "resource_property_code_unique" unique ("tenant_id", "property_id", "code"),
        constraint "resource_property_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "resource_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade,
        constraint "resource_location_fk"
          foreign key ("location_id", "property_id", "tenant_id")
          references "location" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "resource_property_order_idx" on "resource" ("tenant_id", "property_id", "created_at", "id")`,
    );

    this.addSql(`
      insert into "property_limits_profile"
        ("id", "code", "max_resources", "max_composition_depth",
         "max_leaves_per_product", "max_items_per_request", "horizon_nights",
         "max_stay_nights", "search_budget_ms", "lock_wait_ms", "retry_limit")
      values
        ('00000000-0000-4000-8000-000000000001', 'PERF-01', 500, 4, 32, 20,
         365, 365, 500, 2000, 2)
    `);

    const kinds: Array<[string, number]> = [
      ['ROOM', 10],
      ['BED', 20],
      ['VILLA', 30],
      ['APARTMENT', 40],
      ['HOUSE', 50],
      ['SITE', 60],
      ['TENT', 70],
      ['CABIN', 80],
    ];
    for (const [code, sortOrder] of kinds)
      this.addSql(
        `insert into "resource_type" ("code", "name_key", "sort_order")
         values ('${code}', 'resourceTypes.${code}', ${sortOrder})`,
      );

    const catalog: Array<[string, string]> = [
      ['property.read', 'permissions.property.read'],
      ['property.manage', 'permissions.property.manage'],
      ['property.resource.manage', 'permissions.property.resource.manage'],
    ];
    for (const [code, descriptionKey] of catalog)
      this.addSql(
        `insert into "permission" ("code", "description_key")
         values ('${code}', '${descriptionKey}')`,
      );

    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p
          on p."code" in ('property.read', 'property.manage', 'property.resource.manage')
       where r."is_system" = true
         and (
           r."code" = 'TENANT_OWNER'
           or (r."code" = 'TENANT_ADMIN' and p."code" in ('property.read', 'property.manage', 'property.resource.manage'))
           or (r."code" = 'AUDITOR' and p."code" = 'property.read')
         )
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in ('property.read', 'property.manage', 'property.resource.manage')
    `);
    this.addSql(`
      delete from "permission"
       where "code" in ('property.read', 'property.manage', 'property.resource.manage')
    `);
    this.addSql(`drop table if exists "resource"`);
    this.addSql(`drop table if exists "location"`);
    this.addSql(`drop table if exists "property"`);
    this.addSql(`drop table if exists "property_group"`);
    this.addSql(`drop table if exists "resource_type"`);
    this.addSql(`drop table if exists "property_limits_profile"`);
  }
}
