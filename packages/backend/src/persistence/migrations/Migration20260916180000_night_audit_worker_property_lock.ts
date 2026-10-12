import { Migration } from '@mikro-orm/migrations';

/**
 * The night audit engine takes the per-property lock before it touches the
 * business day or the ledger, exactly like every other inventory/finance
 * writer (docs/31: PostgreSQL property lock is the single serialisation
 * point). The worker runs the same engine, so it needs the row-lock privilege
 * on `property`; it remains insert-only on the ledger and cannot update or
 * delete posted financial rows.
 */
export class Migration20260916180000_night_audit_worker_property_lock extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant update on "property" to "hotel_worker"`);
  }

  override async down(): Promise<void> {
    this.addSql(`revoke update on "property" from "hotel_worker"`);
  }
}
