import { Migration } from '@mikro-orm/migrations';

export class Migration20260915130000_import_run_replay_scope extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "reservation_import_run"
        drop constraint "reservation_import_run_hash_unique"
    `);
    this.addSql(`
      alter table "reservation_import_run"
        add constraint "reservation_import_run_hash_unique"
        unique ("tenant_id", "property_id", "file_hash", "mode", "source")
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "reservation_import_run"
        drop constraint "reservation_import_run_hash_unique"
    `);
    this.addSql(`
      alter table "reservation_import_run"
        add constraint "reservation_import_run_hash_unique"
        unique ("tenant_id", "property_id", "file_hash")
    `);
  }
}
