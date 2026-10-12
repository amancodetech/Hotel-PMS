import { Migration } from '@mikro-orm/migrations';

export class Migration20260916130000_disruption_resolution_grant extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant update on "inventory_disruption" to "hotel_api"`);
  }

  override async down(): Promise<void> {
    this.addSql(`revoke update on "inventory_disruption" from "hotel_api"`);
  }
}
