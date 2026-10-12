import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['room_assignment', 'stay_event'];

export class Migration20260915140000_front_office_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "stay_segment"
        add constraint "stay_segment_scope_unique"
        unique ("id", "property_id", "tenant_id")
    `);
    this.addSql(`
      alter table "stay_segment"
        add column "state" varchar(16) not null default 'PLANNED',
        add column "checked_in_at" timestamptz
    `);
    this.addSql(`
      alter table "stay_segment"
        add constraint "stay_segment_state_check"
        check ("state" in ('PLANNED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED'))
    `);

    this.addSql(`
      alter table "reservation_item"
        add column "checked_in_at" timestamptz,
        add column "checked_out_at" timestamptz
    `);

    this.addSql(`
      alter table "reservation"
        add column "financial_clearance_state" varchar(16) not null default 'PENDING'
    `);
    this.addSql(`
      alter table "reservation"
        add constraint "reservation_financial_clearance_check"
        check ("financial_clearance_state" in ('PENDING', 'CLEARED', 'NOT_REQUIRED'))
    `);

    this.addSql(`
      alter table "reservation_guest"
        add column "departed_at" timestamptz
    `);

    this.addSql(`
      create table "room_assignment" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "item_id" uuid not null,
        "segment_id" uuid,
        "resource_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "state" varchar(16) not null default 'PLANNED',
        "version" integer not null default 1,
        "assigned_at" timestamptz not null default now(),
        "checked_in_at" timestamptz,
        "checked_out_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "room_assignment_period_check" check ("end_date" > "start_date"),
        constraint "room_assignment_state_check" check ("state" in ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
        constraint "room_assignment_version_check" check ("version" >= 1),
        constraint "room_assignment_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "room_assignment_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "room_assignment_segment_fk"
          foreign key ("segment_id", "property_id", "tenant_id")
          references "stay_segment" ("id", "property_id", "tenant_id") on delete set null,
        constraint "room_assignment_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      alter table "room_assignment"
        add constraint "room_assignment_no_overlap"
        exclude using gist (
          "resource_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        ) where ("state" in ('PLANNED', 'ACTIVE'))
    `);
    this.addSql(
      `create index "room_assignment_item_idx" on "room_assignment" ("tenant_id", "property_id", "item_id")`,
    );
    this.addSql(
      `create index "room_assignment_resource_idx" on "room_assignment" ("resource_id", "start_date")`,
    );

    this.addSql(`
      create table "stay_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "reservation_id" uuid not null,
        "item_id" uuid not null,
        "segment_id" uuid,
        "type" varchar(32) not null,
        "resource_id" uuid,
        "payload" jsonb not null default '{}'::jsonb,
        "item_version" integer not null,
        "occurred_at" timestamptz not null default now(),
        constraint "stay_event_type_check" check ("type" in (
          'STAY_CHECKED_IN', 'STAY_MOVED', 'STAY_EXTENDED', 'STAY_SPLIT',
          'STAY_EARLY_DEPARTURE', 'STAY_PARTIAL_DEPARTURE', 'STAY_CHECKED_OUT'
        )),
        constraint "stay_event_item_version_check" check ("item_version" >= 1),
        constraint "stay_event_unique" unique ("tenant_id", "property_id", "item_id", "type", "item_version"),
        constraint "stay_event_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "stay_event_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "stay_event_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "stay_event_segment_fk"
          foreign key ("segment_id", "property_id", "tenant_id")
          references "stay_segment" ("id", "property_id", "tenant_id") on delete set null,
        constraint "stay_event_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "stay_event_item_idx" on "stay_event" ("tenant_id", "property_id", "item_id", "occurred_at")`,
    );

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
      grant select, insert, update on "room_assignment" to "hotel_api"
    `);
    this.addSql(`grant select, insert on "stay_event" to "hotel_api"`);
    this.addSql(
      `grant select on "room_assignment", "stay_event" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "room_assignment", "stay_event"
      to "hotel_test"
    `);

    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ('frontdesk.read', 'permissions.frontdesk.read'),
        ('assignment.manage', 'permissions.assignment.manage'),
        ('stay.checkin', 'permissions.stay.checkin'),
        ('stay.move', 'permissions.stay.move'),
        ('stay.checkout', 'permissions.stay.checkout')
      on conflict ("code") do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" in (
          'frontdesk.read', 'assignment.manage', 'stay.checkin',
          'stay.move', 'stay.checkout'
        )
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in (
         'frontdesk.read', 'assignment.manage', 'stay.checkin',
         'stay.move', 'stay.checkout'
       )
    `);
    this.addSql(`
      delete from "permission" where "code" in (
        'frontdesk.read', 'assignment.manage', 'stay.checkin',
        'stay.move', 'stay.checkout'
      )
    `);
    this.addSql(
      `revoke select on "room_assignment", "stay_event" from "hotel_worker"`,
    );
    this.addSql(`
      revoke select, insert, update, delete on
        "room_assignment", "stay_event"
      from "hotel_test"
    `);
    this.addSql(`revoke select, insert on "stay_event" from "hotel_api"`);
    this.addSql(
      `revoke select, insert, update on "room_assignment" from "hotel_api"`,
    );
    this.addSql(`drop table if exists "stay_event" cascade`);
    this.addSql(`drop table if exists "room_assignment" cascade`);
    this.addSql(
      `alter table "reservation_guest" drop column if exists "departed_at"`,
    );
    this.addSql(`
      alter table "reservation"
        drop constraint if exists "reservation_financial_clearance_check"
    `);
    this.addSql(`
      alter table "reservation"
        drop column if exists "financial_clearance_state"
    `);
    this.addSql(`
      alter table "reservation_item"
        drop column if exists "checked_in_at",
        drop column if exists "checked_out_at"
    `);
    this.addSql(`
      alter table "stay_segment"
        drop constraint if exists "stay_segment_state_check"
    `);
    this.addSql(`
      alter table "stay_segment"
        drop column if exists "state",
        drop column if exists "checked_in_at"
    `);
    this.addSql(`
      alter table "stay_segment"
        drop constraint if exists "stay_segment_scope_unique"
    `);
  }
}
