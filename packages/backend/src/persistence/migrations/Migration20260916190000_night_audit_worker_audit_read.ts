import { Migration } from '@mikro-orm/migrations';

/**
 * `insertAudit` uses `returning *`, so the night audit worker needs SELECT on
 * `audit_event` in addition to the insert grant to write its own audit trail.
 * Read-only and tenant-scoped by RLS; no update/delete is granted.
 */
export class Migration20260916190000_night_audit_worker_audit_read extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant select on "audit_event" to "hotel_worker"`);
  }

  override async down(): Promise<void> {
    this.addSql(`revoke select on "audit_event" from "hotel_worker"`);
  }
}
