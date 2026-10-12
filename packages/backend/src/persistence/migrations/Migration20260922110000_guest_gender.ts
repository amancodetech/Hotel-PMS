import { Migration } from '@mikro-orm/migrations';

/**
 * SET-07.6: the guest gender that restricted sharing scopes (FEMALE/MALE bed
 * templates) are enforced against. Nullable on purpose: legacy guests keep a
 * declared UNKNOWN that fails closed when a restricted product is sold.
 */
export class Migration20260922110000_guest_gender extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "guest" add column "gender" varchar(6)`);
    this.addSql(`
      alter table "guest"
        add constraint "guest_gender_check"
        check ("gender" is null or "gender" in ('FEMALE', 'MALE'))
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "guest" drop constraint if exists "guest_gender_check"`,
    );
    this.addSql(`alter table "guest" drop column if exists "gender"`);
  }
}
