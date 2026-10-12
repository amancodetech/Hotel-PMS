import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['folio_refund', 'fx_snapshot'];

const permissionCodes = ['payment.refund.request', 'folio.adjust'];

export class Migration20260915190000_refunds_fx extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "journal"
        add column "adjusts_journal_id" uuid
    `);
    this.addSql(`
      alter table "journal"
        add constraint "journal_adjusts_fk"
        foreign key ("adjusts_journal_id", "property_id", "tenant_id")
        references "journal" ("id", "property_id", "tenant_id") on delete restrict
    `);
    this.addSql(`
      create unique index "journal_reversal_once"
        on "journal" ("adjusts_journal_id")
        where "source_type" = 'REVERSAL'
    `);

    this.addSql(`
      create table "folio_refund" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "payment_id" uuid not null,
        "folio_id" uuid not null,
        "currency" varchar(3) not null,
        "amount" numeric(20, 6) not null,
        "reason" text not null,
        "state" varchar(10) not null default 'RESERVED',
        "approval_id" uuid,
        "journal_id" uuid,
        "evidence_ref" uuid,
        "external_reference" text,
        "reconciliation_reference" text,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "folio_refund_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_refund_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "folio_refund_state_check"
          check ("state" in ('RESERVED', 'PENDING', 'SUCCEEDED', 'FAILED')),
        constraint "folio_refund_journal_check"
          check (("state" = 'SUCCEEDED') = ("journal_id" is not null)),
        constraint "folio_refund_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_refund_payment_fk"
          foreign key ("payment_id", "property_id", "tenant_id")
          references "folio_payment" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_refund_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_refund_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "folio_refund_payment_idx"
        on "folio_refund" ("tenant_id", "property_id", "payment_id", "state")
    `);

    this.addSql(`
      create or replace function public.assert_refund_within_payment()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        target uuid;
        reserved numeric(20, 6);
        paid numeric(20, 6);
      begin
        if tg_op = 'DELETE' then
          target := old."payment_id";
        else
          target := new."payment_id";
        end if;
        select "amount" into paid from "folio_payment" where "id" = target;
        if not found then
          return null;
        end if;
        select coalesce(sum("amount"), 0) into reserved
          from "folio_refund"
         where "payment_id" = target and "state" <> 'FAILED';
        if reserved > paid then
          raise exception 'refunds of payment % exceed the collected amount', target
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger "folio_refund_within_payment"
      after insert or update or delete on "folio_refund"
      deferrable initially deferred
      for each row execute function public.assert_refund_within_payment()
    `);

    this.addSql(`
      create or replace function public.assert_refund_transition()
      returns trigger
      language plpgsql
      as $$
      begin
        if old."state" in ('SUCCEEDED', 'FAILED') then
          raise exception 'refund % is already resolved', old."id"
            using errcode = '23514';
        end if;
        if new."state" = 'RESERVED'
           or (old."state" = 'PENDING' and new."state" = 'PENDING') then
          raise exception 'refund state must advance'
            using errcode = '23514';
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."payment_id" <> old."payment_id"
           or new."folio_id" <> old."folio_id"
           or new."currency" <> old."currency"
           or new."amount" <> old."amount" then
          raise exception 'refund identity is immutable'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "folio_refund_transition_guard"
      before update on "folio_refund"
      for each row execute function public.assert_refund_transition()
    `);

    this.addSql(`
      create table "fx_snapshot" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "pair" varchar(7) not null,
        "rate" numeric(20, 8) not null,
        "effective_at" timestamptz not null,
        "source" text not null,
        "approval_id" uuid not null,
        "recorded_by" uuid,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "fx_snapshot_pair_check" check ("pair" in ('IDR/USD', 'USD/IDR')),
        constraint "fx_snapshot_rate_check" check ("rate" > 0),
        constraint "fx_snapshot_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "fx_snapshot_approval_unique" unique ("tenant_id", "property_id", "approval_id")
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

    this.addSql(
      `grant select, insert, update on "folio_refund" to "hotel_api"`,
    );
    this.addSql(`grant select, insert on "fx_snapshot" to "hotel_api"`);
    this.addSql(
      `grant select on "folio_refund", "fx_snapshot" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on "folio_refund", "fx_snapshot"
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
      revoke select, insert, update, delete on "folio_refund", "fx_snapshot"
      from "hotel_test"
    `);
    this.addSql(
      `revoke select on "folio_refund", "fx_snapshot" from "hotel_worker"`,
    );
    this.addSql(`revoke select, insert on "fx_snapshot" from "hotel_api"`);
    this.addSql(
      `revoke select, insert, update on "folio_refund" from "hotel_api"`,
    );
    this.addSql(
      `drop trigger if exists "folio_refund_within_payment" on "folio_refund"`,
    );
    this.addSql(
      `drop function if exists public.assert_refund_within_payment()`,
    );
    this.addSql(
      `drop trigger if exists "folio_refund_transition_guard" on "folio_refund"`,
    );
    this.addSql(`drop function if exists public.assert_refund_transition()`);
    this.addSql(`drop table if exists "fx_snapshot" cascade`);
    this.addSql(`drop table if exists "folio_refund" cascade`);
    this.addSql(`drop index if exists "journal_reversal_once"`);
    this.addSql(`
      alter table "journal"
        drop constraint if exists "journal_adjusts_fk"
    `);
    this.addSql(`
      alter table "journal"
        drop column if exists "adjusts_journal_id"
    `);
  }
}
