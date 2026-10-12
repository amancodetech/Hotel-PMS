import { Migration } from '@mikro-orm/migrations';

const tenantTables = ['reservation_group_allotment'];

export class Migration20260915090000_reservation_group_split_noshow extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "reservation_item"
        add "owner_stay" boolean not null default false,
        add "split_from_id" uuid
    `);
    this.addSql(`
      alter table "reservation_item"
        add constraint "reservation_item_split_from_fk"
        foreign key ("split_from_id", "property_id", "tenant_id")
        references "reservation_item" ("id", "property_id", "tenant_id")
        on delete set null ("split_from_id")
    `);

    this.addSql(`
      create table "reservation_group_allotment" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "reservation_id" uuid not null,
        "product_id" uuid not null,
        "start_date" date not null,
        "end_date" date not null,
        "quantity" integer not null default 1,
        "state" varchar(16) not null default 'ACTIVE',
        "commitment_id" uuid not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "reservation_group_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "reservation_group_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "reservation_group_commitment_fk"
          foreign key ("commitment_id", "property_id", "tenant_id")
          references "commitment" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "reservation_group_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "reservation_group_period_check" check ("end_date" > "start_date"),
        constraint "reservation_group_quantity_check" check ("quantity" between 1 and 20),
        constraint "reservation_group_state_check" check ("state" in ('ACTIVE','PICKED_UP','RELEASED'))
      )
    `);
    this.addSql(`
      create unique index "reservation_group_active_unique"
        on "reservation_group_allotment" ("reservation_id")
        where "state" = 'ACTIVE'
    `);

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
    this.addSql(
      `grant select, insert, update on "reservation_group_allotment" to "hotel_api"`,
    );
    this.addSql(
      `grant select on "reservation_group_allotment" to "hotel_worker"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "reservation_group_allotment" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`revoke all on "reservation_group_allotment" from "hotel_api"`);
    this.addSql(
      `revoke all on "reservation_group_allotment" from "hotel_worker"`,
    );
    this.addSql(
      `revoke all on "reservation_group_allotment" from "hotel_test"`,
    );
    this.addSql(`drop table if exists "reservation_group_allotment" cascade`);
    this.addSql(`
      alter table "reservation_item"
        drop constraint if exists "reservation_item_split_from_fk",
        drop column if exists "split_from_id",
        drop column if exists "owner_stay"
    `);
  }
}
