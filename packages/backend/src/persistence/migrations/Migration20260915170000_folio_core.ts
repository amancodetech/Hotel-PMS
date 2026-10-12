import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'folio',
  'folio_charge',
  'payer_allocation',
  'charge_schedule',
  'package_entitlement',
  'package_consumption',
  'folio_deposit',
  'deposit_application',
];

const permissionCodes = ['folio.charge'];

export class Migration20260915170000_folio_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "folio" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "reservation_id" uuid,
        "kind" varchar(16) not null default 'GUEST',
        "payer_label" text not null,
        "currency" varchar(3) not null,
        "state" varchar(12) not null default 'OPEN',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "folio_kind_check" check ("kind" in ('GUEST', 'COMPANY', 'HOUSE', 'OWNER')),
        constraint "folio_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_state_check" check ("state" in ('OPEN', 'CLOSED')),
        constraint "folio_version_check" check ("version" >= 1),
        constraint "folio_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict,
        constraint "folio_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "folio_reservation_idx"
        on "folio" ("tenant_id", "property_id", "reservation_id", "state")
    `);

    this.addSql(`
      create table "folio_charge" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "business_date" date not null,
        "currency" varchar(3) not null,
        "kind" varchar(16) not null,
        "account_code" varchar(32) not null,
        "net_amount" numeric(20, 6) not null,
        "tax_amount" numeric(20, 6) not null default 0,
        "tax_policy" jsonb not null default '{}'::jsonb,
        "policy_snapshot_id" uuid,
        "source_kind" varchar(24) not null,
        "source_ref" text not null,
        "period_start" date,
        "period_end" date,
        "memo" text,
        "journal_id" uuid not null,
        "correlation_id" uuid,
        "posted_at" timestamptz not null default now(),
        "created_at" timestamptz not null default now(),
        constraint "folio_charge_kind_check" check ("kind" in (
          'MANUAL', 'POS', 'ACCRUAL', 'PACKAGE', 'DAMAGE_DEPOSIT', 'ROUTING', 'TAX'
        )),
        constraint "folio_charge_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_charge_account_check"
          check ("account_code" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "folio_charge_source_kind_check"
          check ("source_kind" ~ '^[A-Z][A-Z0-9_]{2,23}$'),
        constraint "folio_charge_amount_check" check (
          "net_amount" >= 0 and "tax_amount" >= 0
          and "net_amount" = round("net_amount", 2)
          and "tax_amount" = round("tax_amount", 2)
          and ("net_amount" > 0 or "tax_amount" > 0)
        ),
        constraint "folio_charge_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_charge_source_unique"
          unique ("tenant_id", "property_id", "source_kind", "source_ref"),
        constraint "folio_charge_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_charge_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "folio_charge_folio_idx"
        on "folio_charge" ("tenant_id", "property_id", "folio_id", "business_date")
    `);

    this.addSql(`
      create table "payer_allocation" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "charge_id" uuid not null,
        "payer_folio_id" uuid not null,
        "amount" numeric(20, 6) not null,
        "journal_id" uuid not null,
        "memo" text,
        "created_at" timestamptz not null default now(),
        constraint "payer_allocation_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "payer_allocation_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "payer_allocation_charge_fk"
          foreign key ("charge_id", "property_id", "tenant_id")
          references "folio_charge" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "payer_allocation_folio_fk"
          foreign key ("payer_folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "payer_allocation_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "payer_allocation_charge_idx"
        on "payer_allocation" ("tenant_id", "property_id", "charge_id")
    `);

    this.addSql(`
      create table "charge_schedule" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "code" varchar(32) not null,
        "account_code" varchar(32) not null,
        "quantity" integer not null default 1,
        "net_amount" numeric(20, 6) not null,
        "tax_amount" numeric(20, 6) not null default 0,
        "tax_policy" jsonb not null default '{}'::jsonb,
        "currency" varchar(3) not null,
        "interval" varchar(8) not null,
        "starts_on" date not null,
        "ends_on" date,
        "state" varchar(12) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "charge_schedule_interval_check"
          check ("interval" in ('DAY', 'WEEK', 'MONTH')),
        constraint "charge_schedule_state_check"
          check ("state" in ('ACTIVE', 'STOPPED')),
        constraint "charge_schedule_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "charge_schedule_account_check"
          check ("account_code" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "charge_schedule_amount_check"
          check ("net_amount" >= 0 and "tax_amount" >= 0
                 and "net_amount" = round("net_amount", 2)
                 and "tax_amount" = round("tax_amount", 2)
                 and ("net_amount" > 0 or "tax_amount" > 0)),
        constraint "charge_schedule_quantity_check" check ("quantity" >= 1),
        constraint "charge_schedule_version_check" check ("version" >= 1),
        constraint "charge_schedule_period_check"
          check ("ends_on" is null or "ends_on" > "starts_on"),
        constraint "charge_schedule_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "charge_schedule_code_unique"
          unique ("tenant_id", "property_id", "folio_id", "code"),
        constraint "charge_schedule_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "package_entitlement" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "code" varchar(32) not null,
        "account_code" varchar(32) not null,
        "quantity_total" integer not null,
        "unit_net_amount" numeric(20, 6) not null,
        "unit_tax_amount" numeric(20, 6) not null default 0,
        "tax_policy" jsonb not null default '{}'::jsonb,
        "currency" varchar(3) not null,
        "state" varchar(12) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "package_entitlement_state_check"
          check ("state" in ('ACTIVE', 'EXHAUSTED', 'CANCELLED')),
        constraint "package_entitlement_currency_check"
          check ("currency" in ('IDR', 'USD')),
        constraint "package_entitlement_account_check"
          check ("account_code" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "package_entitlement_amount_check"
          check ("unit_net_amount" >= 0 and "unit_tax_amount" >= 0
                 and "unit_net_amount" = round("unit_net_amount", 2)
                 and "unit_tax_amount" = round("unit_tax_amount", 2)
                 and ("unit_net_amount" > 0 or "unit_tax_amount" > 0)),
        constraint "package_entitlement_quantity_check" check ("quantity_total" >= 1),
        constraint "package_entitlement_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "package_entitlement_code_unique"
          unique ("tenant_id", "property_id", "folio_id", "code"),
        constraint "package_entitlement_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "package_consumption" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "entitlement_id" uuid not null,
        "quantity" integer not null,
        "source_kind" varchar(24) not null,
        "source_ref" text not null,
        "charge_id" uuid not null,
        "consumed_at" timestamptz not null default now(),
        constraint "package_consumption_quantity_check" check ("quantity" >= 1),
        constraint "package_consumption_source_check"
          check ("source_kind" ~ '^[A-Z][A-Z0-9_]{2,23}$'),
        constraint "package_consumption_unique"
          unique ("entitlement_id", "source_kind", "source_ref"),
        constraint "package_consumption_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "package_consumption_entitlement_fk"
          foreign key ("entitlement_id", "property_id", "tenant_id")
          references "package_entitlement" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "package_consumption_charge_fk"
          foreign key ("charge_id", "property_id", "tenant_id")
          references "folio_charge" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "folio_deposit" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "kind" varchar(16) not null,
        "method" varchar(16) not null,
        "currency" varchar(3) not null,
        "amount" numeric(20, 6) not null,
        "external_reference" text not null,
        "evidence_ref" uuid,
        "source_ref" text not null,
        "journal_id" uuid not null,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "folio_deposit_kind_check" check ("kind" in ('DEPOSIT', 'DAMAGE')),
        constraint "folio_deposit_method_check"
          check ("method" in ('CASH', 'BANK_TRANSFER', 'EXTERNAL_POS')),
        constraint "folio_deposit_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_deposit_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "folio_deposit_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_deposit_source_unique"
          unique ("tenant_id", "property_id", "source_ref"),
        constraint "folio_deposit_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_deposit_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "deposit_application" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "deposit_id" uuid not null,
        "charge_id" uuid,
        "kind" varchar(12) not null,
        "amount" numeric(20, 6) not null,
        "reason" text not null,
        "journal_id" uuid not null,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "deposit_application_kind_check" check ("kind" in ('APPLY', 'RELEASE')),
        constraint "deposit_application_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "deposit_application_charge_check"
          check (("kind" = 'APPLY') = ("charge_id" is not null)),
        constraint "deposit_application_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "deposit_application_deposit_fk"
          foreign key ("deposit_id", "property_id", "tenant_id")
          references "folio_deposit" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "deposit_application_charge_fk"
          foreign key ("charge_id", "property_id", "tenant_id")
          references "folio_charge" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "deposit_application_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create or replace function public.assert_charge_allocation_within_charge()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        target uuid;
        allocated numeric(20, 6);
        charge_total numeric(20, 6);
      begin
        if tg_op = 'DELETE' then
          target := old."charge_id";
        else
          target := new."charge_id";
        end if;
        select ("net_amount" + "tax_amount") into charge_total
          from "folio_charge" where "id" = target;
        if not found then
          return null;
        end if;
        select coalesce(sum("amount"), 0) into allocated
          from "payer_allocation" where "charge_id" = target;
        if allocated > charge_total then
          raise exception 'charge % allocations exceed the charge total', target
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger "payer_allocation_within_charge"
      after insert or update or delete on "payer_allocation"
      deferrable initially deferred
      for each row execute function public.assert_charge_allocation_within_charge()
    `);

    this.addSql(`
      create or replace function public.assert_package_within_entitlement()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        target uuid;
        consumed integer;
        allowed integer;
      begin
        if tg_op = 'DELETE' then
          target := old."entitlement_id";
        else
          target := new."entitlement_id";
        end if;
        select "quantity_total" into allowed
          from "package_entitlement" where "id" = target;
        if not found then
          return null;
        end if;
        select coalesce(sum("quantity"), 0) into consumed
          from "package_consumption" where "entitlement_id" = target;
        if consumed > allowed then
          raise exception 'package % consumption exceeds the entitlement', target
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger "package_consumption_within_entitlement"
      after insert or update or delete on "package_consumption"
      deferrable initially deferred
      for each row execute function public.assert_package_within_entitlement()
    `);

    this.addSql(`
      create or replace function public.assert_deposit_within_amount()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        target uuid;
        moved numeric(20, 6);
        deposit_amount numeric(20, 6);
      begin
        if tg_op = 'DELETE' then
          target := old."deposit_id";
        else
          target := new."deposit_id";
        end if;
        select "amount" into deposit_amount
          from "folio_deposit" where "id" = target;
        if not found then
          return null;
        end if;
        select coalesce(sum("amount"), 0) into moved
          from "deposit_application" where "deposit_id" = target;
        if moved > deposit_amount then
          raise exception 'deposit % applications exceed the deposit amount', target
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger "deposit_application_within_amount"
      after insert or update or delete on "deposit_application"
      deferrable initially deferred
      for each row execute function public.assert_deposit_within_amount()
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

    this.addSql(`grant select, insert, update on "folio" to "hotel_api"`);
    this.addSql(`
      grant select, insert on
        "folio_charge", "payer_allocation", "package_consumption",
        "folio_deposit", "deposit_application"
      to "hotel_api"
    `);
    this.addSql(`
      grant select, insert, update on "charge_schedule", "package_entitlement"
      to "hotel_api"
    `);
    this.addSql(`
      grant select on
        "folio", "folio_charge", "payer_allocation", "charge_schedule",
        "package_entitlement", "package_consumption", "folio_deposit",
        "deposit_application"
      to "hotel_worker"
    `);
    this.addSql(`
      grant select, insert, update, delete on
        "folio", "folio_charge", "payer_allocation", "charge_schedule",
        "package_entitlement", "package_consumption", "folio_deposit",
        "deposit_application"
      to "hotel_test"
    `);

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
    this.addSql(`
      revoke select, insert, update, delete on
        "folio", "folio_charge", "payer_allocation", "charge_schedule",
        "package_entitlement", "package_consumption", "folio_deposit",
        "deposit_application"
      from "hotel_test"
    `);
    this.addSql(`
      revoke select on
        "folio", "folio_charge", "payer_allocation", "charge_schedule",
        "package_entitlement", "package_consumption", "folio_deposit",
        "deposit_application"
      from "hotel_worker"
    `);
    this.addSql(`
      revoke select, insert, update on "charge_schedule", "package_entitlement"
      from "hotel_api"
    `);
    this.addSql(`
      revoke select, insert on
        "folio_charge", "payer_allocation", "package_consumption",
        "folio_deposit", "deposit_application"
      from "hotel_api"
    `);
    this.addSql(`revoke select, insert, update on "folio" from "hotel_api"`);
    this.addSql(
      `drop trigger if exists "deposit_application_within_amount" on "deposit_application"`,
    );
    this.addSql(
      `drop function if exists public.assert_deposit_within_amount()`,
    );
    this.addSql(
      `drop trigger if exists "package_consumption_within_entitlement" on "package_consumption"`,
    );
    this.addSql(
      `drop function if exists public.assert_package_within_entitlement()`,
    );
    this.addSql(
      `drop trigger if exists "payer_allocation_within_charge" on "payer_allocation"`,
    );
    this.addSql(
      `drop function if exists public.assert_charge_allocation_within_charge()`,
    );
    this.addSql(`drop table if exists "deposit_application" cascade`);
    this.addSql(`drop table if exists "folio_deposit" cascade`);
    this.addSql(`drop table if exists "package_consumption" cascade`);
    this.addSql(`drop table if exists "package_entitlement" cascade`);
    this.addSql(`drop table if exists "charge_schedule" cascade`);
    this.addSql(`drop table if exists "payer_allocation" cascade`);
    this.addSql(`drop table if exists "folio_charge" cascade`);
    this.addSql(`drop table if exists "folio" cascade`);
  }
}
