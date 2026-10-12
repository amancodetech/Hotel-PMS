import { Migration } from '@mikro-orm/migrations';

export class Migration20260915120000_revision_exception_resolution extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant update on "distribution_exception_case" to "hotel_api"`);
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke update on "distribution_exception_case" from "hotel_api"`,
    );
  }
}
