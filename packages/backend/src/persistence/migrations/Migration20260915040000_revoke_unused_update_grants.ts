import { Migration } from '@mikro-orm/migrations';

export class Migration20260915040000_revoke_unused_update_grants extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      revoke update on
        "price_quote", "inventory_block_resource", "inventory_disruption"
      from "hotel_api"
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      grant update on
        "price_quote", "inventory_block_resource", "inventory_disruption"
      to "hotel_api"
    `);
  }
}
