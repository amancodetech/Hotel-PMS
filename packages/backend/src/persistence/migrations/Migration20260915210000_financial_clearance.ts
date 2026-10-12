import { Migration } from '@mikro-orm/migrations';

/**
 * P08-06: financial clearance for a reservation (D-13 / docs/06).
 *
 * `financial_clearance_state` itself was created by P07-03 and stays PENDING
 * after an operational check-out. This migration adds the evidence columns
 * used when P08-06 resolves that state against the subledger: who/when, the
 * basis (`SETTLED` = guest ledger at zero through posted payments/deposits/
 * refunds/routing; `TRANSFER_TO_PAYER` = outstanding balance routed to an
 * authorized COMPANY payer folio/city ledger with a documented collection
 * plan reference). "Departed" never implies "settled": only these two bases
 * may set CLEARED, and any later financial posting reopens it to PENDING.
 */
export class Migration20260915210000_financial_clearance extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "reservation"
        add column "financial_cleared_at" timestamptz,
        add column "financial_clearance_basis" varchar(24),
        add column "financial_clearance_reference" text,
        add column "financial_clearance_payer_folio_id" uuid
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from "reservation"
           where "financial_clearance_state" <> 'PENDING'
        ) then
          raise exception 'reservation rows already clearanced before P08-06 evidence columns exist';
        end if;
      end $$;
    `);
    this.addSql(`
      alter table "reservation"
        add constraint "reservation_clearance_basis_check"
          check ("financial_clearance_basis" is null
                 or "financial_clearance_basis" in ('SETTLED', 'TRANSFER_TO_PAYER')),
        add constraint "reservation_clearance_evidence_check"
          check (("financial_cleared_at" is null) = ("financial_clearance_basis" is null)
                 and ("financial_clearance_basis" is distinct from 'TRANSFER_TO_PAYER'
                      or ("financial_clearance_payer_folio_id" is not null
                          and "financial_clearance_reference" is not null))),
        add constraint "reservation_clearance_state_check"
          check (("financial_clearance_state" = 'CLEARED') = ("financial_cleared_at" is not null)),
        add constraint "reservation_clearance_payer_folio_fk"
          foreign key ("financial_clearance_payer_folio_id", "property_id", "tenant_id")
          references "folio" ("id", "property_id", "tenant_id") on delete restrict
    `);
    this.addSql(`
      create index "reservation_clearance_pending_idx"
        on "reservation" ("tenant_id", "property_id", "financial_clearance_state")
        where "financial_clearance_state" = 'PENDING'
    `);
    // The clearance view reads the external booking link of an OTA
    // reservation. Read-only and scoped by RLS; the writer stays the worker.
    this.addSql(
      `grant select on "distribution_external_booking" to "hotel_api"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke select on "distribution_external_booking" from "hotel_api"`,
    );
    this.addSql(`drop index if exists "reservation_clearance_pending_idx"`);
    this.addSql(`
      alter table "reservation"
        drop constraint if exists "reservation_clearance_payer_folio_fk",
        drop constraint if exists "reservation_clearance_state_check",
        drop constraint if exists "reservation_clearance_evidence_check",
        drop constraint if exists "reservation_clearance_basis_check"
    `);
    this.addSql(`
      alter table "reservation"
        drop column if exists "financial_clearance_payer_folio_id",
        drop column if exists "financial_clearance_reference",
        drop column if exists "financial_clearance_basis",
        drop column if exists "financial_cleared_at"
    `);
  }
}
