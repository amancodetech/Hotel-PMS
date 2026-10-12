import { Migration } from '@mikro-orm/migrations';

/**
 * A setup unit code is the stable logical slot used by simulation for a
 * composite product that has no physical resource of its own (for example a
 * connected suite). Keep it unique inside a property so lookup is
 * deterministic under concurrent setup writes.
 */
export class Migration20260921150000_setup_unit_slot_unique extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index "product_setup_unit_slot_unique"
        on "product" ("tenant_id", "property_id", "setup_unit_code")
       where "setup_unit_code" is not null
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "product_setup_unit_slot_unique"`);
  }
}
