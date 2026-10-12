import { Migration } from '@mikro-orm/migrations';

export class Migration20260915100000_revision_consumer extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `grant select, update on "distribution_inbox_revision" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert on "distribution_exception_case" to "hotel_api"`,
    );
    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ('channel.reprocess', 'permissions.channel.reprocess')
      on conflict ("code") do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" = 'channel.reprocess'
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission" where "permission_code" = 'channel.reprocess'
    `);
    this.addSql(`delete from "permission" where "code" = 'channel.reprocess'`);
    this.addSql(
      `revoke select, update on "distribution_inbox_revision" from "hotel_api"`,
    );
    this.addSql(
      `revoke select, insert on "distribution_exception_case" from "hotel_api"`,
    );
  }
}
