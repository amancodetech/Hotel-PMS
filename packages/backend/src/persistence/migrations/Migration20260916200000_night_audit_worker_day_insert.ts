import { Migration } from '@mikro-orm/migrations';

/**
 * Closing the day opens the next business day (`insert ... on conflict do
 * nothing returning *`), so the night audit worker needs INSERT on
 * `business_day` in addition to the update used for state transitions.
 */
export class Migration20260916200000_night_audit_worker_day_insert extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant insert on "business_day" to "hotel_worker"`);
  }

  override async down(): Promise<void> {
    this.addSql(`revoke insert on "business_day" from "hotel_worker"`);
  }
}
