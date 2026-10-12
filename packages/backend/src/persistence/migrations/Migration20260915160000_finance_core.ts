import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['business_day', 'journal', 'journal_line'];

const permissionCodes = ['folio.read', 'business_day.close'];

export class Migration20260915160000_finance_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "business_day" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "business_date" date not null,
        "state" varchar(20) not null default 'OPEN',
        "version" integer not null default 1,
        "opened_at" timestamptz not null default now(),
        "closed_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "business_day_state_check" check ("state" in (
          'OPEN', 'AUDIT_PREPARING', 'AUDIT_VALIDATION', 'CLOSING', 'CLOSED'
        )),
        constraint "business_day_version_check" check ("version" >= 1),
        constraint "business_day_closed_check"
          check (("state" = 'CLOSED') = ("closed_at" is not null)),
        constraint "business_day_unique" unique ("tenant_id", "property_id", "business_date"),
        constraint "business_day_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "business_day_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create unique index "business_day_single_active"
        on "business_day" ("tenant_id", "property_id")
        where "state" <> 'CLOSED'
    `);

    this.addSql(`
      create table "journal" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "business_date" date not null,
        "currency" varchar(3) not null,
        "source_type" varchar(32) not null,
        "source_id" uuid,
        "reversal_of_id" uuid,
        "state" varchar(10) not null default 'POSTED',
        "memo" text,
        "total_debit" numeric(20, 6) not null,
        "total_credit" numeric(20, 6) not null,
        "correlation_id" uuid,
        "posted_at" timestamptz not null default now(),
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "journal_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "journal_state_check" check ("state" in ('DRAFT', 'POSTED')),
        constraint "journal_source_type_check"
          check ("source_type" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "journal_totals_check"
          check ("total_debit" >= 0 and "total_credit" >= 0),
        constraint "journal_balanced_check"
          check ("state" <> 'POSTED' or "total_debit" = "total_credit"),
        constraint "journal_scale_check"
          check ("total_debit" = round("total_debit", 2)
                 and "total_credit" = round("total_credit", 2)),
        constraint "journal_posted_at_check"
          check (("state" = 'POSTED') = ("posted_at" is not null)),
        constraint "journal_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "journal_source_unique"
          unique ("tenant_id", "property_id", "source_type", "source_id"),
        constraint "journal_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict,
        constraint "journal_reversal_fk"
          foreign key ("reversal_of_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "journal_property_date_idx"
        on "journal" ("tenant_id", "property_id", "business_date")
    `);

    this.addSql(`
      create table "journal_line" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "journal_id" uuid not null,
        "line_no" integer not null,
        "account_code" varchar(32) not null,
        "debit" numeric(20, 6) not null default 0,
        "credit" numeric(20, 6) not null default 0,
        "memo" text,
        "created_at" timestamptz not null default now(),
        constraint "journal_line_line_no_check" check ("line_no" >= 1),
        constraint "journal_line_account_check"
          check ("account_code" ~ '^[A-Z][A-Z0-9_]{2,31}$'),
        constraint "journal_line_nonnegative_check"
          check ("debit" >= 0 and "credit" >= 0),
        constraint "journal_line_single_side_check"
          check ("debit" = 0 or "credit" = 0),
        constraint "journal_line_nonzero_check"
          check ("debit" > 0 or "credit" > 0),
        constraint "journal_line_scale_check"
          check ("debit" = round("debit", 2) and "credit" = round("credit", 2)),
        constraint "journal_line_unique" unique ("journal_id", "line_no"),
        constraint "journal_line_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "journal_line_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "journal_line_journal_idx"
        on "journal_line" ("tenant_id", "property_id", "journal_id", "line_no")
    `);

    this.addSql(`
      create or replace function public.assert_business_day_transition()
      returns trigger
      language plpgsql
      as $$
      declare
        old_rank integer;
        new_rank integer;
      begin
        if old."state" = 'CLOSED' then
          raise exception 'CLOSED business day cannot be changed'
            using errcode = '23514';
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."business_date" <> old."business_date" then
          raise exception 'business day identity is immutable'
            using errcode = '23514';
        end if;
        old_rank := array_position(
          array['OPEN', 'AUDIT_PREPARING', 'AUDIT_VALIDATION', 'CLOSING', 'CLOSED'],
          old."state"
        );
        new_rank := array_position(
          array['OPEN', 'AUDIT_PREPARING', 'AUDIT_VALIDATION', 'CLOSING', 'CLOSED'],
          new."state"
        );
        if new_rank is null or new_rank <= old_rank then
          raise exception 'business day state must advance'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "business_day_transition_guard"
      before update on "business_day"
      for each row execute function public.assert_business_day_transition()
    `);

    this.addSql(`
      create or replace function public.assert_journal_postable()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        day_state varchar(20);
      begin
        if new."state" <> 'POSTED' then
          return new;
        end if;
        select "state" into day_state
          from "business_day"
         where "tenant_id" = new."tenant_id"
           and "property_id" = new."property_id"
           and "business_date" = new."business_date";
        if not found then
          raise exception 'no business day for %', new."business_date"
            using errcode = '23514';
        end if;
        if day_state <> 'OPEN' then
          raise exception 'business day % is not open', new."business_date"
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "journal_postable_guard"
      before insert on "journal"
      for each row execute function public.assert_journal_postable()
    `);

    this.addSql(`
      create or replace function public.assert_journal_line_balance()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        target uuid;
        line_totals record;
        journal_totals record;
      begin
        if tg_op = 'DELETE' then
          target := old."journal_id";
        else
          target := new."journal_id";
        end if;
        select "total_debit", "total_credit" into journal_totals
          from "journal" where "id" = target;
        if not found then
          return null;
        end if;
        select coalesce(sum("debit"), 0) as "debit",
               coalesce(sum("credit"), 0) as "credit"
          into line_totals
          from "journal_line" where "journal_id" = target;
        if line_totals."debit" <> line_totals."credit"
           or line_totals."debit" <> journal_totals."total_debit"
           or line_totals."credit" <> journal_totals."total_credit" then
          raise exception 'journal % is not balanced', target
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger "journal_line_balance_check"
      after insert or update or delete on "journal_line"
      deferrable initially deferred
      for each row execute function public.assert_journal_line_balance()
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
      grant select, insert, update on "business_day" to "hotel_api"
    `);
    this.addSql(`grant select, insert on "journal" to "hotel_api"`);
    this.addSql(`grant select, insert on "journal_line" to "hotel_api"`);
    this.addSql(
      `grant select on "business_day", "journal", "journal_line" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "business_day", "journal", "journal_line"
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
        "business_day", "journal", "journal_line"
      from "hotel_test"
    `);
    this.addSql(
      `revoke select on "business_day", "journal", "journal_line" from "hotel_worker"`,
    );
    this.addSql(`revoke select, insert on "journal_line" from "hotel_api"`);
    this.addSql(`revoke select, insert on "journal" from "hotel_api"`);
    this.addSql(
      `revoke select, insert, update on "business_day" from "hotel_api"`,
    );
    this.addSql(
      `drop trigger if exists "journal_line_balance_check" on "journal_line"`,
    );
    this.addSql(`drop function if exists public.assert_journal_line_balance()`);
    this.addSql(`drop trigger if exists "journal_postable_guard" on "journal"`);
    this.addSql(`drop function if exists public.assert_journal_postable()`);
    this.addSql(
      `drop trigger if exists "business_day_transition_guard" on "business_day"`,
    );
    this.addSql(
      `drop function if exists public.assert_business_day_transition()`,
    );
    this.addSql(`drop table if exists "journal_line" cascade`);
    this.addSql(`drop table if exists "journal" cascade`);
    this.addSql(`drop table if exists "business_day" cascade`);
  }
}
