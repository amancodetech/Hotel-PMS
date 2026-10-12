import { Migration } from '@mikro-orm/migrations';

export class Migration20260914320000_phase4_least_privilege extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      revoke delete on "product", "inventory_pool", "pool_member"
      from "hotel_api"
    `);
    this.addSql(`
      revoke update, delete on "composition_edge", "composition_leaf"
      from "hotel_api"
    `);
    this.addSql(`revoke delete on "composition_version" from "hotel_api"`);
  }

  override async down(): Promise<void> {
    this.addSql(`
      grant delete on "product", "inventory_pool", "pool_member"
      to "hotel_api"
    `);
    this.addSql(`
      grant update, delete on "composition_edge", "composition_leaf"
      to "hotel_api"
    `);
    this.addSql(`grant delete on "composition_version" to "hotel_api"`);
  }
}
