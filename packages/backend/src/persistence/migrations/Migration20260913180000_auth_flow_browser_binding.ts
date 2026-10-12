import { Migration } from '@mikro-orm/migrations';

export class Migration20260913180000_auth_flow_browser_binding extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auth_flow"
        add column "browser_secret_hash" char(64)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "auth_flow" drop column "browser_secret_hash"`);
  }
}
