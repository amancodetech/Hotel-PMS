import { Migration } from '@mikro-orm/migrations';

export class Migration20260915030000_inventory_outbox_grants extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `grant select, insert on "distribution_outbox_event" to "hotel_api"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke select, insert on "distribution_outbox_event" from "hotel_api"`,
    );
  }
}
