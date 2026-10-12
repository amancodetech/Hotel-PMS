import { Migration } from '@mikro-orm/migrations';

export class Migration20260921140000_resource_containment extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "resource" add "parent_resource_id" uuid`);
    this.addSql(`
      alter table "resource"
        add constraint "resource_parent_self_check"
        check ("parent_resource_id" is null or "parent_resource_id" <> "id")
    `);
    this.addSql(`
      alter table "resource"
        add constraint "resource_parent_scope_fk"
        foreign key ("parent_resource_id", "property_id", "tenant_id")
        references "resource" ("id", "property_id", "tenant_id")
        on delete restrict
    `);
    this.addSql(
      `create index "resource_parent_idx" on "resource" ("tenant_id", "property_id", "parent_resource_id")`,
    );

    this.addSql(`alter table "product" add "setup_unit_code" varchar(80)`);
    this.addSql(
      `create index "product_setup_unit_idx" on "product" ("tenant_id", "property_id", "setup_unit_code")`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "product_setup_unit_idx"`);
    this.addSql(
      `alter table "product" drop column if exists "setup_unit_code"`,
    );
    this.addSql(`drop index if exists "resource_parent_idx"`);
    this.addSql(
      `alter table "resource" drop constraint if exists "resource_parent_scope_fk"`,
    );
    this.addSql(
      `alter table "resource" drop constraint if exists "resource_parent_self_check"`,
    );
    this.addSql(
      `alter table "resource" drop column if exists "parent_resource_id"`,
    );
  }
}
