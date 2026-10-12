import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'rate_plan',
  'rate_policy_version',
  'nightly_price',
  'price_quote',
];

export class Migration20260915010000_rate_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "rate_plan" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "product_id" uuid not null,
        "code" varchar(80) not null,
        "name" varchar(160) not null,
        "currency" varchar(3) not null,
        "occupancy_basis" integer not null default 2,
        "meal_plan" varchar(16) not null default 'NONE',
        "inclusions" jsonb not null default '[]'::jsonb,
        "cancellation_policy" jsonb not null default '{}'::jsonb,
        "free_policy" boolean not null default false,
        "status" varchar(16) not null default 'DRAFT',
        "policy_version" integer not null default 1,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "rate_plan_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "rate_plan_meal_check" check ("meal_plan" in ('NONE', 'BREAKFAST')),
        constraint "rate_plan_status_check" check ("status" in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
        constraint "rate_plan_occupancy_check" check ("occupancy_basis" between 1 and 100),
        constraint "rate_plan_policy_version_check" check ("policy_version" >= 1),
        constraint "rate_plan_code_unique" unique ("tenant_id", "property_id", "code"),
        constraint "rate_plan_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "rate_plan_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "rate_plan_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "rate_plan_product_idx" on "rate_plan" ("tenant_id", "property_id", "product_id", "status")`,
    );

    this.addSql(`
      create table "rate_policy_version" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "rate_plan_id" uuid not null,
        "version_number" integer not null,
        "occupancy_basis" integer not null,
        "meal_plan" varchar(16) not null,
        "inclusions" jsonb not null default '[]'::jsonb,
        "cancellation_policy" jsonb not null default '{}'::jsonb,
        "free_policy" boolean not null default false,
        "created_at" timestamptz not null default now(),
        constraint "rate_policy_meal_check" check ("meal_plan" in ('NONE', 'BREAKFAST')),
        constraint "rate_policy_occupancy_check" check ("occupancy_basis" between 1 and 100),
        constraint "rate_policy_number_unique" unique ("rate_plan_id", "version_number"),
        constraint "rate_policy_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "rate_policy_plan_fk"
          foreign key ("rate_plan_id", "property_id", "tenant_id")
          references "rate_plan" ("id", "property_id", "tenant_id") on delete cascade
      )
    `);

    this.addSql(`
      create table "nightly_price" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "rate_plan_id" uuid not null,
        "policy_version_id" uuid not null,
        "stay_date" date not null,
        "occupancy" integer not null,
        "amount" numeric(20, 6) not null,
        "currency" varchar(3) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "nightly_price_amount_check" check ("amount" >= 0),
        constraint "nightly_price_occupancy_check" check ("occupancy" between 1 and 100),
        constraint "nightly_price_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "nightly_price_unique" unique ("rate_plan_id", "stay_date", "occupancy"),
        constraint "nightly_price_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "nightly_price_plan_fk"
          foreign key ("rate_plan_id", "property_id", "tenant_id")
          references "rate_plan" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "nightly_price_policy_fk"
          foreign key ("policy_version_id", "property_id", "tenant_id")
          references "rate_policy_version" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "nightly_price_calendar_idx" on "nightly_price" ("tenant_id", "property_id", "stay_date")`,
    );

    this.addSql(`
      create table "price_quote" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "rate_plan_id" uuid not null,
        "policy_version_id" uuid not null,
        "product_id" uuid not null,
        "currency" varchar(3) not null,
        "start_date" date not null,
        "end_date" date not null,
        "quantity" integer not null,
        "adults" integer not null,
        "child_ages" jsonb not null default '[]'::jsonb,
        "total_amount" numeric(20, 6) not null,
        "cells" jsonb not null,
        "inventory_version" integer not null,
        "expires_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "price_quote_period_check" check ("end_date" > "start_date"),
        constraint "price_quote_quantity_check" check ("quantity" between 1 and 20),
        constraint "price_quote_amount_check" check ("total_amount" >= 0),
        constraint "price_quote_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "price_quote_plan_fk"
          foreign key ("rate_plan_id", "property_id", "tenant_id")
          references "rate_plan" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "price_quote_policy_fk"
          foreign key ("policy_version_id", "property_id", "tenant_id")
          references "rate_policy_version" ("id", "property_id", "tenant_id") on delete restrict
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

    this.addSql(`
      grant select, insert, update on
        "rate_plan", "nightly_price", "price_quote"
      to "hotel_api"
    `);
    this.addSql(`grant select, insert on "rate_policy_version" to "hotel_api"`);
    this.addSql(
      `grant select on "rate_plan", "rate_policy_version", "nightly_price", "price_quote" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "rate_plan", "rate_policy_version", "nightly_price", "price_quote"
      to "hotel_test"
    `);

    const catalog: Array<[string, string]> = [
      ['rate.manage', 'permissions.rate.manage'],
      ['reservation.read', 'permissions.reservation.read'],
      ['reservation.create', 'permissions.reservation.create'],
      ['inventory.block', 'permissions.inventory.block'],
      ['maintenance.emergency', 'permissions.maintenance.emergency'],
      ['channel.sale.manage', 'permissions.channel.sale.manage'],
      ['channel.reconcile', 'permissions.channel.reconcile'],
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
          on p."code" in (
            'rate.manage', 'reservation.read', 'reservation.create',
            'inventory.block', 'maintenance.emergency',
            'channel.sale.manage', 'channel.reconcile'
          )
       where r."is_system" = true
         and (
           r."code" = 'TENANT_OWNER'
           or r."code" = 'TENANT_ADMIN'
           or (r."code" = 'AUDITOR' and p."code" = 'reservation.read')
         )
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in (
         'rate.manage', 'reservation.read', 'reservation.create',
         'inventory.block', 'maintenance.emergency',
         'channel.sale.manage', 'channel.reconcile'
       )
    `);
    this.addSql(`
      delete from "permission"
       where "code" in (
         'rate.manage', 'reservation.read', 'reservation.create',
         'inventory.block', 'maintenance.emergency',
         'channel.sale.manage', 'channel.reconcile'
       )
    `);
    this.addSql(
      `revoke select on "rate_plan", "rate_policy_version", "nightly_price", "price_quote" from "hotel_worker"`,
    );
    this.addSql(`
      revoke select, insert, update, delete on
        "rate_plan", "rate_policy_version", "nightly_price", "price_quote"
      from "hotel_test"
    `);
    this.addSql(
      `revoke select, insert on "rate_policy_version" from "hotel_api"`,
    );
    this.addSql(`
      revoke select, insert, update on
        "rate_plan", "nightly_price", "price_quote"
      from "hotel_api"
    `);
    for (const table of tenantTables) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    }
    this.addSql(`drop table if exists "price_quote"`);
    this.addSql(`drop table if exists "nightly_price"`);
    this.addSql(`drop table if exists "rate_policy_version"`);
    this.addSql(`drop table if exists "rate_plan"`);
  }
}
