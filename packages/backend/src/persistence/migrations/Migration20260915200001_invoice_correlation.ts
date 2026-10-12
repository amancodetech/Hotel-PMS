import { Migration } from '@mikro-orm/migrations';

export class Migration20260915200001_invoice_correlation extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "folio_invoice"
        add column "correlation_id" uuid
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "folio_invoice"
        drop column if exists "correlation_id"
    `);
  }
}
