import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'invoice_counter',
  'folio_invoice',
  'folio_credit_note',
  'cashier_session',
];

const permissionCodes = ['invoice.issue', 'cashier.operate'];

export class Migration20260915200000_invoices_cashier extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "invoice_counter" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "series" varchar(8) not null,
        "kind" varchar(12) not null default 'SYNTHETIC',
        "approved" boolean not null default false,
        "next_number" bigint not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "invoice_counter_kind_check" check ("kind" in ('SYNTHETIC', 'PRODUCTION')),
        constraint "invoice_counter_series_check" check ("series" ~ '^[A-Z0-9]{1,8}$'),
        constraint "invoice_counter_next_check" check ("next_number" >= 1),
        constraint "invoice_counter_unique" unique ("tenant_id", "property_id", "series"),
        constraint "invoice_counter_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "invoice_counter_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "folio_invoice" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "series" varchar(8) not null,
        "number" bigint not null,
        "kind" varchar(12) not null,
        "currency" varchar(3) not null,
        "net_amount" numeric(20, 6) not null,
        "tax_amount" numeric(20, 6) not null default 0,
        "total_amount" numeric(20, 6) not null,
        "tax_policy" jsonb not null default '{}'::jsonb,
        "account_code" varchar(32) not null default 'REVENUE_OTHER',
        "state" varchar(10) not null default 'ISSUED',
        "source_ref" text not null,
        "business_date" date not null,
        "journal_id" uuid,
        "issued_at" timestamptz not null default now(),
        "created_at" timestamptz not null default now(),
        constraint "folio_invoice_kind_check" check ("kind" in ('SYNTHETIC', 'PRODUCTION')),
        constraint "folio_invoice_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_invoice_amount_check" check (
          "net_amount" >= 0 and "tax_amount" >= 0
          and "net_amount" = round("net_amount", 2)
          and "tax_amount" = round("tax_amount", 2)
          and "total_amount" = "net_amount" + "tax_amount"
          and "total_amount" > 0
        ),
        constraint "folio_invoice_state_check" check ("state" = 'ISSUED'),
        constraint "folio_invoice_account_check"
          check ("account_code" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "folio_invoice_number_unique"
          unique ("tenant_id", "property_id", "series", "number"),
        constraint "folio_invoice_source_unique"
          unique ("tenant_id", "property_id", "source_ref"),
        constraint "folio_invoice_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_invoice_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_invoice_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "folio_invoice_folio_idx"
        on "folio_invoice" ("tenant_id", "property_id", "folio_id", "issued_at")
    `);

    this.addSql(`
      create table "folio_credit_note" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "invoice_id" uuid not null,
        "series" varchar(8) not null,
        "number" bigint not null,
        "currency" varchar(3) not null,
        "amount" numeric(20, 6) not null,
        "reason" text not null,
        "source_ref" text not null,
        "journal_id" uuid not null,
        "issued_at" timestamptz not null default now(),
        constraint "folio_credit_note_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_credit_note_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "folio_credit_note_number_unique"
          unique ("tenant_id", "property_id", "series", "number"),
        constraint "folio_credit_note_source_unique"
          unique ("tenant_id", "property_id", "source_ref"),
        constraint "folio_credit_note_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_credit_note_invoice_fk"
          foreign key ("invoice_id", "property_id", "tenant_id")
          references "folio_invoice" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_credit_note_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "cashier_session" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "currency" varchar(3) not null,
        "state" varchar(12) not null default 'OPEN',
        "opening_float" numeric(20, 6) not null default 0,
        "expected_amount" numeric(20, 6),
        "counted_amount" numeric(20, 6),
        "variance" numeric(20, 6),
        "opened_by" uuid,
        "counted_by" uuid,
        "closed_by" uuid,
        "opened_at" timestamptz not null default now(),
        "counted_at" timestamptz,
        "closed_at" timestamptz,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "cashier_session_state_check"
          check ("state" in ('OPEN', 'COUNTING', 'RECONCILED', 'CLOSED')),
        constraint "cashier_session_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "cashier_session_amounts_check" check (
          "opening_float" >= 0 and "opening_float" = round("opening_float", 2)
          and ("expected_amount" is null
               or ("expected_amount" = round("expected_amount", 2)
                   and "expected_amount" >= 0))
          and ("counted_amount" is null or "counted_amount" = round("counted_amount", 2))
          and ("variance" is null or "variance" = round("variance", 2))
        ),
        constraint "cashier_session_count_check" check (
          ("state" in ('RECONCILED', 'CLOSED'))
          = ("expected_amount" is not null and "counted_amount" is not null
             and "variance" is not null)
        ),
        constraint "cashier_session_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "cashier_session_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create unique index "cashier_session_single_open"
        on "cashier_session" ("tenant_id", "property_id", "currency")
        where "state" in ('OPEN', 'COUNTING')
    `);

    this.addSql(`
      create or replace function public.assert_cashier_transition()
      returns trigger
      language plpgsql
      as $$
      declare
        old_rank integer;
        new_rank integer;
      begin
        if old."state" = 'CLOSED' then
          raise exception 'CLOSED cashier session cannot be changed'
            using errcode = '23514';
        end if;
        old_rank := array_position(array['OPEN','COUNTING','RECONCILED','CLOSED'], old."state");
        new_rank := array_position(array['OPEN','COUNTING','RECONCILED','CLOSED'], new."state");
        if new_rank <= old_rank then
          raise exception 'cashier session state must advance'
            using errcode = '23514';
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."currency" <> old."currency"
           or new."opening_float" <> old."opening_float" then
          raise exception 'cashier session identity is immutable'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "cashier_session_transition_guard"
      before update on "cashier_session"
      for each row execute function public.assert_cashier_transition()
    `);

    for (const table of tenantTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
          with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
      if (table !== 'invoice_counter') {
        this.addSql(`
          create trigger "prevent_tenant_id_change"
          before update on "${table}"
          for each row execute function public.prevent_tenant_id_change()
        `);
      }
    }

    this.addSql(
      `grant select, insert, update on "invoice_counter", "cashier_session" to "hotel_api"`,
    );
    this.addSql(`
      grant select, insert on "folio_invoice", "folio_credit_note" to "hotel_api"
    `);
    this.addSql(
      `grant select on "invoice_counter", "folio_invoice", "folio_credit_note", "cashier_session" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "invoice_counter", "folio_invoice", "folio_credit_note", "cashier_session"
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
    this.addSql(
      `delete from "role_permission" where "permission_code" in (${permissionList})`,
    );
    this.addSql(`delete from "permission" where "code" in (${permissionList})`);
    this.addSql(`
      revoke select, insert, update, delete on
        "invoice_counter", "folio_invoice", "folio_credit_note", "cashier_session"
      from "hotel_test"
    `);
    this.addSql(
      `revoke select on "invoice_counter", "folio_invoice", "folio_credit_note", "cashier_session" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select, insert on "folio_invoice", "folio_credit_note" from "hotel_api"`,
    );
    this.addSql(
      `revoke select, insert, update on "invoice_counter", "cashier_session" from "hotel_api"`,
    );
    this.addSql(
      `drop trigger if exists "cashier_session_transition_guard" on "cashier_session"`,
    );
    this.addSql(`drop function if exists public.assert_cashier_transition()`);
    this.addSql(`drop table if exists "cashier_session" cascade`);
    this.addSql(`drop table if exists "folio_credit_note" cascade`);
    this.addSql(`drop table if exists "folio_invoice" cascade`);
    this.addSql(`drop table if exists "invoice_counter" cascade`);
  }
}
