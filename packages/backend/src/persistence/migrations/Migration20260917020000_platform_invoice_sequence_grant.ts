import { Migration } from '@mikro-orm/migrations';

/**
 * P12-01 fix: administrative invoice numbers come from
 * `platform_invoice_number_seq`; the operating roles need USAGE on the
 * sequence in addition to the table grants, otherwise invoice issue fails
 * with 42501. The migration that created the sequence is untouched.
 */
export class Migration20260917020000_platform_invoice_sequence_grant extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `grant usage on sequence "platform_invoice_number_seq" to "hotel_api"`,
    );
    this.addSql(
      `grant usage on sequence "platform_invoice_number_seq" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke usage on sequence "platform_invoice_number_seq" from "hotel_api"`,
    );
    this.addSql(
      `revoke usage on sequence "platform_invoice_number_seq" from "hotel_test"`,
    );
  }
}
