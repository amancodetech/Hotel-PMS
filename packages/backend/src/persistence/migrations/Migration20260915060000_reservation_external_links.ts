import { Migration } from '@mikro-orm/migrations';

export class Migration20260915060000_reservation_external_links extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "distribution_external_booking" add column "property_id" uuid`,
    );
    this.addSql(`
      update "distribution_external_booking" b
         set "property_id" = c."property_id"
        from "distribution_connection" c
       where c."id" = b."connection_id" and b."property_id" is null
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from "distribution_external_booking" where "property_id" is null
        ) then
          raise exception 'distribution_external_booking rows without property scope';
        end if;
      end $$;
    `);
    this.addSql(
      `alter table "distribution_external_booking" alter column "property_id" set not null`,
    );
    this.addSql(`
      alter table "distribution_external_booking"
        add constraint "distribution_external_booking_reservation_fk"
        foreign key ("reservation_ref", "property_id", "tenant_id")
        references "reservation" ("id", "property_id", "tenant_id")
        on delete set null ("reservation_ref")
    `);
    this.addSql(
      `create index "distribution_external_booking_reservation_idx" on "distribution_external_booking" ("reservation_ref")`,
    );

    this.addSql(
      `alter table "distribution_inbox_revision" add column "property_id" uuid`,
    );
    this.addSql(
      `alter table "distribution_inbox_revision" add column "reservation_ref" uuid`,
    );
    this.addSql(`
      alter table "distribution_inbox_revision"
        drop constraint if exists "distribution_inbox_booking_tenant_fk",
        drop constraint if exists "distribution_inbox_exception_tenant_fk",
        drop constraint if exists "distribution_inbox_ack_exception_tenant_fk"
    `);
    this.addSql(`
      update "distribution_inbox_revision" i
         set "property_id" = c."property_id"
        from "distribution_connection" c
       where c."id" = i."connection_id" and i."property_id" is null
    `);
    this.addSql(`
      alter table "distribution_inbox_revision"
        add constraint "distribution_inbox_booking_tenant_fk"
        foreign key ("external_booking_ref", "tenant_id")
        references "distribution_external_booking" ("id", "tenant_id") not valid,
        add constraint "distribution_inbox_exception_tenant_fk"
        foreign key ("exception_id", "tenant_id")
        references "distribution_exception_case" ("id", "tenant_id") not valid,
        add constraint "distribution_inbox_ack_exception_tenant_fk"
        foreign key ("ack_exception_id", "tenant_id")
        references "distribution_exception_case" ("id", "tenant_id") not valid
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from "distribution_inbox_revision" where "property_id" is null
        ) then
          raise exception 'distribution_inbox_revision rows without property scope';
        end if;
      end $$;
    `);
    this.addSql(
      `alter table "distribution_inbox_revision" alter column "property_id" set not null`,
    );
    this.addSql(`
      alter table "distribution_inbox_revision"
        add constraint "distribution_inbox_revision_reservation_fk"
        foreign key ("reservation_ref", "property_id", "tenant_id")
        references "reservation" ("id", "property_id", "tenant_id")
        on delete set null ("reservation_ref")
    `);
    this.addSql(
      `create index "distribution_inbox_revision_reservation_idx" on "distribution_inbox_revision" ("reservation_ref")`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "distribution_inbox_revision_reservation_idx"`,
    );
    this.addSql(`
      alter table "distribution_inbox_revision"
        drop constraint if exists "distribution_inbox_revision_reservation_fk"
    `);
    this.addSql(
      `alter table "distribution_inbox_revision" drop column if exists "reservation_ref"`,
    );
    this.addSql(
      `alter table "distribution_inbox_revision" drop column if exists "property_id"`,
    );
    this.addSql(
      `drop index if exists "distribution_external_booking_reservation_idx"`,
    );
    this.addSql(`
      alter table "distribution_external_booking"
        drop constraint if exists "distribution_external_booking_reservation_fk"
    `);
    this.addSql(
      `alter table "distribution_external_booking" drop column if exists "property_id"`,
    );
  }
}
