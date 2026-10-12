import { Migration } from '@mikro-orm/migrations';

const tenantTables = [
  'guest',
  'reservation',
  'reservation_item',
  'stay_segment',
  'reservation_guest',
];

export class Migration20260915050000_reservation_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "guest" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "full_name" varchar(200) not null,
        "email" varchar(320),
        "phone" varchar(40),
        "country_code" char(2),
        "language" varchar(16),
        "notes" varchar(2000),
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "guest_tenant_scope_unique" unique ("id", "tenant_id"),
        constraint "guest_name_check" check (length(trim("full_name")) between 1 and 200),
        constraint "guest_email_check" check ("email" is null or "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'),
        constraint "guest_version_check" check ("version" >= 1)
      )
    `);
    this.addSql(
      `create index "guest_tenant_name_idx" on "guest" ("tenant_id", lower("full_name"))`,
    );

    this.addSql(`
      create table "reservation" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "source" varchar(16) not null default 'DIRECT',
        "channel_connection_id" uuid,
        "external_booking_key" varchar(200),
        "state" varchar(32) not null default 'INQUIRY',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "reservation_property_fk" foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade,
        constraint "reservation_connection_fk" foreign key ("channel_connection_id")
          references "distribution_connection" ("id") on delete set null,
        constraint "reservation_tenant_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "reservation_source_check" check ("source" in ('DIRECT', 'OTA', 'IMPORT')),
        constraint "reservation_state_check" check ("state" in ('INQUIRY','TENTATIVE','WAITLIST','CONFIRMED','PARTIALLY_CONFIRMED','IN_HOUSE','PARTIALLY_IN_HOUSE','CHECKED_OUT','PARTIALLY_CHECKED_OUT','COMPLETED','CANCELLED','NO_SHOW')),
        constraint "reservation_version_check" check ("version" >= 1),
        constraint "reservation_external_key_check" check (("source" = 'DIRECT') = ("external_booking_key" is null))
      )
    `);
    this.addSql(
      `create index "reservation_list_idx" on "reservation" ("tenant_id", "property_id", "state", "created_at" desc)`,
    );
    this.addSql(`
      create unique index "reservation_external_unique"
        on "reservation" ("channel_connection_id", "external_booking_key")
        where "external_booking_key" is not null
    `);

    this.addSql(`
      create table "reservation_item" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "reservation_id" uuid not null,
        "product_id" uuid,
        "arrival" date not null,
        "departure" date not null,
        "adults" integer not null default 1,
        "child_ages" jsonb not null default '[]',
        "quantity" integer not null default 1,
        "state" varchar(32) not null default 'INQUIRY',
        "price_snapshot_id" uuid,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "reservation_item_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "reservation_item_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "reservation_item_tenant_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "reservation_item_period_check" check ("departure" > "arrival"),
        constraint "reservation_item_adults_check" check ("adults" between 1 and 20),
        constraint "reservation_item_quantity_check" check ("quantity" between 1 and 20),
        constraint "reservation_item_state_check" check ("state" in ('INQUIRY','TENTATIVE','WAITLIST','CONFIRMED','IN_HOUSE','CHECKED_OUT','COMPLETED','CANCELLED','NO_SHOW')),
        constraint "reservation_item_version_check" check ("version" >= 1)
      )
    `);
    this.addSql(
      `create index "reservation_item_list_idx" on "reservation_item" ("tenant_id", "property_id", "state", "arrival")`,
    );

    this.addSql(`
      create table "stay_segment" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "item_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "composition_version_id" uuid,
        "rate_snapshot" jsonb,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "stay_segment_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "stay_segment_dates_check" check ("end_date" > "start_date"),
        constraint "stay_segment_no_overlap" exclude using gist (
          "item_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        )
      )
    `);
    this.addSql(
      `create index "stay_segment_item_idx" on "stay_segment" ("item_id", "start_date")`,
    );

    this.addSql(`
      create table "reservation_guest" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "reservation_id" uuid not null,
        "item_id" uuid,
        "guest_id" uuid not null,
        "role" varchar(16) not null default 'ACCOMPANYING',
        "created_at" timestamptz not null default now(),
        constraint "reservation_guest_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "reservation_guest_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "reservation_guest_guest_fk"
          foreign key ("guest_id", "tenant_id")
          references "guest" ("id", "tenant_id") on delete restrict,
        constraint "reservation_guest_role_check" check ("role" in ('LEAD', 'ACCOMPANYING')),
        constraint "reservation_guest_unique" unique ("reservation_id", "guest_id", "role")
      )
    `);
    this.addSql(`
      create unique index "reservation_guest_lead_unique"
        on "reservation_guest" ("reservation_id")
        where "role" = 'LEAD'
    `);
    this.addSql(
      `create index "reservation_guest_guest_idx" on "reservation_guest" ("guest_id", "tenant_id")`,
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
      grant select, insert, update on
        "guest", "reservation", "reservation_item", "reservation_guest"
      to "hotel_api"
    `);
    this.addSql(`grant select, insert on "stay_segment" to "hotel_api"`);
    this.addSql(`
      grant select on
        "guest", "reservation", "reservation_item", "stay_segment", "reservation_guest"
      to "hotel_worker"
    `);
    this.addSql(`
      grant select, insert, update, delete on
        "guest", "reservation", "reservation_item", "stay_segment", "reservation_guest"
      to "hotel_test"
    `);

    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ('guest.read', 'permissions.guest.read'),
        ('guest.manage', 'permissions.guest.manage')
      on conflict ("code") do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" in ('guest.read', 'guest.manage')
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in ('guest.read', 'guest.manage')
    `);
    this.addSql(
      `delete from "permission" where "code" in ('guest.read', 'guest.manage')`,
    );
    this.addSql(
      `revoke all on "guest", "reservation", "reservation_item", "stay_segment", "reservation_guest" from "hotel_api"`,
    );
    this.addSql(
      `revoke all on "guest", "reservation", "reservation_item", "stay_segment", "reservation_guest" from "hotel_worker"`,
    );
    this.addSql(
      `revoke all on "guest", "reservation", "reservation_item", "stay_segment", "reservation_guest" from "hotel_test"`,
    );
    for (const table of [...tenantTables].reverse()) {
      this.addSql(`drop table if exists "${table}" cascade`);
    }
  }
}
