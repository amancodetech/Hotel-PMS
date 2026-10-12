import { Migration } from '@mikro-orm/migrations';

export class Migration20260914310000_owner_references extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "grant_property"
        add constraint "grant_property_property_fk"
        foreign key ("property_ref", "tenant_id")
        references "property" ("id", "tenant_id") on delete restrict
    `);
    this.addSql(
      `create index "grant_property_property_idx" on "grant_property" ("property_ref", "tenant_id")`,
    );

    this.addSql(`
      alter table "distribution_connection"
        add constraint "distribution_connection_property_fk"
        foreign key ("property_id", "tenant_id")
        references "property" ("id", "tenant_id") on delete restrict
        not valid
    `);
    this.addSql(
      `create index "distribution_connection_property_idx" on "distribution_connection" ("property_id", "tenant_id")`,
    );

    this.addSql(`
      grant select, insert, update on
        "distribution_connection", "distribution_mapping_version",
        "distribution_channel_capability"
      to "hotel_api"
    `);
    this.addSql(
      `grant execute on function public.distribution_quarantined(text, uuid) to "hotel_api"`,
    );

    const catalog: Array<[string, string]> = [
      ['channel.read', 'permissions.channel.read'],
      ['channel.connection.manage', 'permissions.channel.connection.manage'],
      ['channel.mapping.manage', 'permissions.channel.mapping.manage'],
    ];
    for (const [code, descriptionKey] of catalog)
      this.addSql(
        `insert into "permission" ("code", "description_key")
         values ('${code}', '${descriptionKey}')`,
      );
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p
          on p."code" in ('channel.read', 'channel.connection.manage', 'channel.mapping.manage')
       where r."is_system" = true
         and (
           r."code" = 'TENANT_OWNER'
           or (
             r."code" = 'TENANT_ADMIN'
             and p."code" in ('channel.read', 'channel.connection.manage', 'channel.mapping.manage')
           )
           or (r."code" = 'AUDITOR' and p."code" = 'channel.read')
         )
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke execute on function public.distribution_quarantined(text, uuid) from "hotel_api"`,
    );
    this.addSql(`
      revoke select, insert, update on
        "distribution_connection", "distribution_mapping_version",
        "distribution_channel_capability"
      from "hotel_api"
    `);
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in ('channel.read', 'channel.connection.manage', 'channel.mapping.manage')
    `);
    this.addSql(`
      delete from "permission"
       where "code" in ('channel.read', 'channel.connection.manage', 'channel.mapping.manage')
    `);
    this.addSql(`drop index if exists "distribution_connection_property_idx"`);
    this.addSql(`
      alter table "distribution_connection"
        drop constraint if exists "distribution_connection_property_fk"
    `);
    this.addSql(`drop index if exists "grant_property_property_idx"`);
    this.addSql(`
      alter table "grant_property"
        drop constraint if exists "grant_property_property_fk"
    `);
  }
}
