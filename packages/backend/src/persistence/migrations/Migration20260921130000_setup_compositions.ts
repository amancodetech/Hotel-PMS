import { Migration } from '@mikro-orm/migrations';

export class Migration20260921130000_setup_compositions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "product"
        add "sharing_scope" varchar(8)
    `);
    this.addSql(`
      alter table "product"
        add constraint "product_sharing_scope_check"
        check ("sharing_scope" is null or "sharing_scope" in ('MIXED', 'FEMALE', 'MALE'))
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "product" drop constraint if exists "product_sharing_scope_check"`,
    );
    this.addSql(`alter table "product" drop column if exists "sharing_scope"`);
  }
}
