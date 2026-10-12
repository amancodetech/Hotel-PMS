import { Migration } from '@mikro-orm/migrations';

export class Migration20260915070000_reservation_confirmation extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "reservation" add "confirmed_at" timestamptz`);
    this.addSql(`
      alter table "reservation_item"
        add "confirmed_at" timestamptz,
        add "cancelled_at" timestamptz,
        add "cancellation_reason" varchar(500)
    `);

    this.addSql(`
      create table "api_idempotency" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "property_id" uuid,
        "operation" varchar(64) not null,
        "key" varchar(200) not null,
        "request_hash" char(64) not null,
        "response_safe" jsonb not null default '{}',
        "resource_id" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "api_idempotency_unique" unique ("tenant_id", "operation", "key"),
        constraint "api_idempotency_key_check" check (length("key") between 8 and 200),
        constraint "api_idempotency_operation_check" check (length("operation") between 3 and 64)
      )
    `);
    this.addSql(
      `create index "api_idempotency_tenant_idx" on "api_idempotency" ("tenant_id", "created_at" desc)`,
    );
    this.addSql(`alter table "api_idempotency" enable row level security`);
    this.addSql(`alter table "api_idempotency" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "api_idempotency"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "api_idempotency"
      for each row execute function public.prevent_tenant_id_change()
    `);
    this.addSql(
      `grant select, insert, update on "api_idempotency" to "hotel_api"`,
    );
    this.addSql(`grant select on "api_idempotency" to "hotel_worker"`);
    this.addSql(
      `grant select, insert, update, delete on "api_idempotency" to "hotel_test"`,
    );

    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ('reservation.modify', 'permissions.reservation.modify'),
        ('reservation.cancel', 'permissions.reservation.cancel')
      on conflict ("code") do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p
          on p."code" in ('reservation.modify', 'reservation.cancel')
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in ('reservation.modify', 'reservation.cancel')
    `);
    this.addSql(`
      delete from "permission"
       where "code" in ('reservation.modify', 'reservation.cancel')
    `);
    this.addSql(`drop table if exists "api_idempotency" cascade`);
    this.addSql(`
      alter table "reservation_item"
        drop column if exists "confirmed_at",
        drop column if exists "cancelled_at",
        drop column if exists "cancellation_reason"
    `);
    this.addSql(
      `alter table "reservation" drop column if exists "confirmed_at"`,
    );
  }
}
