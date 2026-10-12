import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'commitment',
  'plan_allocation',
  'inventory_block',
  'inventory_block_resource',
  'inventory_disruption',
  'exposure',
  'exposure_allocation',
  'sale_restriction',
  'exposure_preview',
];

export class Migration20260915020000_inventory_guarantee extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create extension if not exists btree_gist`);
    this.addSql(`
      alter table "distribution_connection"
        add constraint "distribution_connection_scope_unique"
        unique ("id", "property_id", "tenant_id")
    `);

    this.addSql(`
      create table "commitment" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "source_kind" varchar(16) not null,
        "source_id" uuid not null,
        "state" varchar(16) not null default 'ACTIVE',
        "expires_at" timestamptz,
        "inventory_version" integer not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "commitment_source_check" check ("source_kind" in ('HOLD', 'ITEM', 'GROUP')),
        constraint "commitment_state_check" check ("state" in ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED')),
        constraint "commitment_hold_expiry_check" check ("source_kind" <> 'HOLD' or "expires_at" is not null),
        constraint "commitment_source_unique" unique ("tenant_id", "property_id", "source_kind", "source_id"),
        constraint "commitment_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "commitment_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "commitment_expiry_idx" on "commitment" ("tenant_id", "property_id", "state", "expires_at")`,
    );

    this.addSql(`
      create table "plan_allocation" (
        "id" uuid primary key default gen_random_uuid(),
        "commitment_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "state" varchar(16) not null default 'ACTIVE',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "plan_allocation_period_check" check ("end_date" > "start_date"),
        constraint "plan_allocation_state_check" check ("state" in ('ACTIVE', 'RELEASED')),
        constraint "plan_allocation_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "plan_allocation_commitment_fk"
          foreign key ("commitment_id", "property_id", "tenant_id")
          references "commitment" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "plan_allocation_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      alter table "plan_allocation"
        add constraint "plan_allocation_no_overlap"
        exclude using gist (
          "resource_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        ) where ("state" = 'ACTIVE')
    `);
    this.addSql(
      `create index "plan_allocation_resource_idx" on "plan_allocation" ("tenant_id", "property_id", "resource_id", "state", "start_date")`,
    );

    this.addSql(`
      create table "inventory_block" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "mode" varchar(16) not null,
        "reason" varchar(1000) not null,
        "state" varchar(16) not null default 'ACTIVE',
        "start_date" date not null,
        "end_date" date not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "inventory_block_mode_check" check ("mode" in ('PLANNED', 'EMERGENCY')),
        constraint "inventory_block_state_check" check ("state" in ('ACTIVE', 'RELEASED')),
        constraint "inventory_block_period_check" check ("end_date" > "start_date"),
        constraint "inventory_block_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "inventory_block_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);

    this.addSql(`
      create table "inventory_block_resource" (
        "block_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "created_at" timestamptz not null default now(),
        constraint "inventory_block_resource_pk" primary key ("block_id", "resource_id"),
        constraint "inventory_block_resource_block_fk"
          foreign key ("block_id", "property_id", "tenant_id")
          references "inventory_block" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "inventory_block_resource_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "inventory_block_resource_idx" on "inventory_block_resource" ("tenant_id", "property_id", "resource_id")`,
    );

    this.addSql(`
      create table "inventory_disruption" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "block_id" uuid not null,
        "allocation_id" uuid not null,
        "resource_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "state" varchar(16) not null default 'OPEN',
        "note" varchar(1000),
        "created_at" timestamptz not null default now(),
        "resolved_at" timestamptz,
        constraint "inventory_disruption_state_check" check ("state" in ('OPEN', 'RESOLVED')),
        constraint "inventory_disruption_block_fk"
          foreign key ("block_id", "property_id", "tenant_id")
          references "inventory_block" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "inventory_disruption_allocation_fk"
          foreign key ("allocation_id", "property_id", "tenant_id")
          references "plan_allocation" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "inventory_disruption_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "exposure" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid not null,
        "product_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "mode" varchar(16) not null default 'PARTS',
        "state" varchar(24) not null default 'DRAFT',
        "epoch" integer not null default 1,
        "inventory_version" integer not null,
        "preview_version" integer not null default 1,
        "cutoff" timestamptz,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "exposure_mode_check" check ("mode" in ('WHOLE', 'PARTS')),
        constraint "exposure_state_check" check ("state" in ('DRAFT', 'RESERVED', 'PUBLISHING', 'ACTIVE', 'WITHDRAWING', 'RECONCILING', 'RELEASED', 'UNKNOWN')),
        constraint "exposure_period_check" check ("end_date" > "start_date"),
        constraint "exposure_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "exposure_connection_fk"
          foreign key ("connection_id", "property_id", "tenant_id")
          references "distribution_connection" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "exposure_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "exposure_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "exposure_state_idx" on "exposure" ("tenant_id", "property_id", "state", "start_date")`,
    );

    this.addSql(`
      create table "exposure_allocation" (
        "id" uuid primary key default gen_random_uuid(),
        "exposure_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "state" varchar(16) not null default 'RESERVED',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "exposure_allocation_period_check" check ("end_date" > "start_date"),
        constraint "exposure_allocation_state_check" check ("state" in ('RESERVED', 'RELEASED')),
        constraint "exposure_allocation_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "exposure_allocation_exposure_fk"
          foreign key ("exposure_id", "property_id", "tenant_id")
          references "exposure" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "exposure_allocation_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      alter table "exposure_allocation"
        add constraint "exposure_allocation_no_overlap"
        exclude using gist (
          "resource_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        ) where ("state" = 'RESERVED')
    `);

    this.addSql(`
      create table "sale_restriction" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid not null,
        "product_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "reason" varchar(1000) not null,
        "state" varchar(16) not null default 'ACTIVE',
        "opened_at" timestamptz,
        "opened_by" uuid,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "sale_restriction_state_check" check ("state" in ('ACTIVE', 'OPENED')),
        constraint "sale_restriction_period_check" check ("end_date" > "start_date"),
        constraint "sale_restriction_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "sale_restriction_connection_fk"
          foreign key ("connection_id", "property_id", "tenant_id")
          references "distribution_connection" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "sale_restriction_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "sale_restriction_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "sale_restriction_open_idx" on "sale_restriction" ("tenant_id", "property_id", "connection_id", "product_id", "state")`,
    );

    this.addSql(`
      create table "exposure_preview" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid not null,
        "product_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "mode" varchar(16) not null,
        "resource_ids" jsonb not null,
        "inventory_version" integer not null,
        "preview_version" integer not null,
        "allowed" boolean not null,
        "reason_codes" jsonb not null default '[]'::jsonb,
        "expires_at" timestamptz not null,
        "created_at" timestamptz not null default now(),
        constraint "exposure_preview_mode_check" check ("mode" in ('WHOLE', 'PARTS')),
        constraint "exposure_preview_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "exposure_preview_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
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
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction"
      to "hotel_api"
    `);
    this.addSql(`grant select, insert on "exposure_preview" to "hotel_api"`);
    this.addSql(`
      grant select on
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction",
        "exposure_preview"
      to "hotel_worker"
    `);
    this.addSql(`
      grant select, insert, update, delete on
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction",
        "exposure_preview"
      to "hotel_test"
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      revoke select on
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction",
        "exposure_preview"
      from "hotel_worker"
    `);
    this.addSql(`
      revoke select, insert, update, delete on
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction",
        "exposure_preview"
      from "hotel_test"
    `);
    this.addSql(`revoke select, insert on "exposure_preview" from "hotel_api"`);
    this.addSql(`
      revoke select, insert, update on
        "commitment", "plan_allocation", "inventory_block",
        "inventory_block_resource", "inventory_disruption",
        "exposure", "exposure_allocation", "sale_restriction"
      from "hotel_api"
    `);
    for (const table of tenantTables) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    }
    for (const table of [
      'exposure_preview',
      'sale_restriction',
      'exposure_allocation',
      'exposure',
      'inventory_disruption',
      'inventory_block_resource',
      'inventory_block',
      'plan_allocation',
      'commitment',
    ])
      this.addSql(`drop table if exists "${table}"`);
    this.addSql(`
      alter table "distribution_connection"
        drop constraint if exists "distribution_connection_scope_unique"
    `);
  }
}
