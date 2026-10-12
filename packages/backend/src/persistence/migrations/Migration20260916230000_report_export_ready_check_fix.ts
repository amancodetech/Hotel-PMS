import { Migration } from '@mikro-orm/migrations';

/**
 * `report_export_ready_check` originally required ready_at to be null for any
 * non-READY state, which conflicts with keeping ready_at as history when a
 * READY export later expires or is revoked. The corrected predicate only
 * requires ready_at whenever the state is READY.
 */
export class Migration20260916230000_report_export_ready_check_fix extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "report_export"
        drop constraint if exists "report_export_ready_check"
    `);
    this.addSql(`
      alter table "report_export"
        add constraint "report_export_ready_check"
        check ("state" <> 'READY' or "ready_at" is not null)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "report_export"
        drop constraint if exists "report_export_ready_check"
    `);
    this.addSql(`
      alter table "report_export"
        add constraint "report_export_ready_check"
        check (("state" = 'READY') = ("ready_at" is not null))
    `);
  }
}
