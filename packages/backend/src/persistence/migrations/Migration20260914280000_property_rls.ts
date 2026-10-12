import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'property_group',
  'property',
  'location',
  'resource',
] as const;

export class Migration20260914280000_property_rls extends Migration {
  override async up(): Promise<void> {
    for (const table of tenantTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
          with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
      this.addSql(`
        create trigger "prevent_tenant_id_change"
        before update on "${table}"
        for each row execute function public.prevent_tenant_id_change()
      `);
    }

    this.addSql(`
      grant select, insert, update on
        "property_group", "property", "location", "resource"
      to "hotel_api"
    `);
    this.addSql(
      `grant select on "resource_type", "property_limits_profile" to "hotel_api"`,
    );

    this.addSql(
      `grant select on "property", "location", "resource", "resource_type", "property_limits_profile" to "hotel_worker"`,
    );

    this.addSql(`
      grant select, insert, update, delete on
        "property_group", "property", "location", "resource"
      to "hotel_test"
    `);
    this.addSql(
      `grant select on "resource_type", "property_limits_profile" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`
      revoke select, insert, update on
        "property_group", "property", "location", "resource"
      from "hotel_api"
    `);
    this.addSql(
      `revoke select on "resource_type", "property_limits_profile" from "hotel_api"`,
    );
    this.addSql(
      `revoke select on "property", "location", "resource", "resource_type", "property_limits_profile" from "hotel_worker"`,
    );
    this.addSql(`
      revoke select, insert, update, delete on
        "property_group", "property", "location", "resource"
      from "hotel_test"
    `);
    this.addSql(
      `revoke select on "resource_type", "property_limits_profile" from "hotel_test"`,
    );
    for (const table of tenantTables) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    }
  }
}
