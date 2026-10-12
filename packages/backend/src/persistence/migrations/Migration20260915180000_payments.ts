import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['folio_payment'];

const permissionCodes = ['payment.record'];

export class Migration20260915180000_payments extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "folio_payment" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "folio_id" uuid not null,
        "method" varchar(16) not null,
        "currency" varchar(3) not null,
        "amount" numeric(20, 6) not null,
        "gross_amount" numeric(20, 6),
        "commission_amount" numeric(20, 6),
        "business_date" date not null,
        "external_reference" text not null,
        "evidence_ref" uuid,
        "source_ref" text not null,
        "state" varchar(12) not null default 'SUCCEEDED',
        "journal_id" uuid,
        "reconciled_at" timestamptz,
        "reconciliation_reference" text,
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "folio_payment_method_check"
          check ("method" in ('CASH', 'BANK_TRANSFER', 'OTA_SETTLEMENT', 'EXTERNAL_POS')),
        constraint "folio_payment_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "folio_payment_amount_check"
          check ("amount" > 0 and "amount" = round("amount", 2)),
        constraint "folio_payment_state_check"
          check ("state" in ('UNKNOWN', 'SUCCEEDED', 'FAILED')),
        constraint "folio_payment_journal_check"
          check (("state" = 'SUCCEEDED') = ("journal_id" is not null)),
        constraint "folio_payment_settlement_check"
          check (("gross_amount" is null) = ("commission_amount" is null)),
        constraint "folio_payment_settlement_math_check"
          check ("gross_amount" is null
                 or ("gross_amount" = "amount" + "commission_amount"
                     and "commission_amount" >= 0)),
        constraint "folio_payment_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "folio_payment_source_unique"
          unique ("tenant_id", "property_id", "source_ref"),
        constraint "folio_payment_folio_fk"
          foreign key ("folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "folio_payment_journal_fk"
          foreign key ("journal_id", "property_id", "tenant_id")
          references "journal" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "folio_payment_folio_idx"
        on "folio_payment" ("tenant_id", "property_id", "folio_id", "created_at")
    `);

    this.addSql(`
      create or replace function public.assert_payment_transition()
      returns trigger
      language plpgsql
      as $$
      begin
        if old."state" <> 'UNKNOWN' then
          raise exception 'payment % is already resolved', old."id"
            using errcode = '23514';
        end if;
        if new."state" not in ('SUCCEEDED', 'FAILED') then
          raise exception 'payment % can only move from UNKNOWN to a resolved state', old."id"
            using errcode = '23514';
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."folio_id" <> old."folio_id"
           or new."method" <> old."method"
           or new."currency" <> old."currency"
           or new."amount" <> old."amount"
           or new."source_ref" <> old."source_ref" then
          raise exception 'payment identity is immutable'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "folio_payment_transition_guard"
      before update on "folio_payment"
      for each row execute function public.assert_payment_transition()
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
      `grant select, insert, update on "folio_payment" to "hotel_api"`,
    );
    this.addSql(`grant select on "folio_payment" to "hotel_worker"`);
    this.addSql(
      `grant select, insert, update, delete on "folio_payment" to "hotel_test"`,
    );

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
    this.addSql(
      `revoke select, insert, update, delete on "folio_payment" from "hotel_test"`,
    );
    this.addSql(`revoke select on "folio_payment" from "hotel_worker"`);
    this.addSql(
      `revoke select, insert, update on "folio_payment" from "hotel_api"`,
    );
    this.addSql(
      `drop trigger if exists "folio_payment_transition_guard" on "folio_payment"`,
    );
    this.addSql(`drop function if exists public.assert_payment_transition()`);
    this.addSql(`drop table if exists "folio_payment" cascade`);
  }
}
