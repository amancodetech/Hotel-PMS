import { Migration } from '@mikro-orm/migrations';

export class Migration20260916150000_operations_shift_notifications extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "ops_shift_handover" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "shift_date" date not null,
        "from_membership_id" uuid,
        "to_membership_id" uuid,
        "follow_up_membership_id" uuid,
        "open_tasks" integer not null default 0,
        "open_work_orders" integer not null default 0,
        "active_dnd" integer not null default 0,
        "cashier_session_id" uuid,
        "cashier_currency" varchar(3),
        "cashier_expected_amount" numeric(20, 6),
        "cashier_counted_amount" numeric(20, 6),
        "cashier_variance" numeric(20, 6),
        "exceptions_text" text,
        "note" text,
        "created_by_membership_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "ops_shift_handover_counts_check"
          check ("open_tasks" >= 0 and "open_work_orders" >= 0 and "active_dnd" >= 0),
        constraint "ops_shift_handover_currency_check"
          check ("cashier_currency" is null or "cashier_currency" in ('IDR', 'USD')),
        constraint "ops_shift_handover_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "ops_shift_handover_cashier_fk"
          foreign key ("cashier_session_id", "property_id", "tenant_id")
          references "cashier_session" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_shift_handover_from_fk"
          foreign key ("from_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_shift_handover_to_fk"
          foreign key ("to_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_shift_handover_follow_fk"
          foreign key ("follow_up_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_shift_handover_creator_fk"
          foreign key ("created_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "ops_shift_handover_date_idx"
        on "ops_shift_handover" ("tenant_id", "property_id", "shift_date")
    `);

    this.addSql(`
      create table "ops_notification" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "type" varchar(32) not null,
        "severity" varchar(16) not null default 'INFO',
        "title" text not null,
        "body" text,
        "resource_type" varchar(64),
        "resource_id" uuid,
        "recipient_membership_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "ops_notification_type_check" check ("type" in (
          'WORK_ORDER_EMERGENCY', 'TASK_READY_FOR_INSPECTION', 'SHIFT_HANDOVER'
        )),
        constraint "ops_notification_severity_check"
          check ("severity" in ('INFO', 'WARNING', 'CRITICAL')),
        constraint "ops_notification_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "ops_notification_recipient_fk"
          foreign key ("recipient_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "ops_notification_board_idx"
        on "ops_notification" ("tenant_id", "property_id", "created_at" desc)
    `);

    this.addSql(`
      create table "ops_notification_receipt" (
        "notification_id" uuid not null,
        "membership_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "read_at" timestamptz not null default now(),
        primary key ("notification_id", "membership_id"),
        constraint "ops_notification_receipt_scope_unique"
          unique ("notification_id", "membership_id", "property_id", "tenant_id"),
        constraint "ops_notification_receipt_notification_fk"
          foreign key ("notification_id", "property_id", "tenant_id")
          references "ops_notification" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "ops_notification_receipt_membership_fk"
          foreign key ("membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);

    for (const table of [
      'ops_shift_handover',
      'ops_notification',
      'ops_notification_receipt',
    ]) {
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
      `grant select, insert on "ops_shift_handover", "ops_notification", "ops_notification_receipt" to "hotel_api"`,
    );
    this.addSql(
      `grant select on "ops_shift_handover", "ops_notification", "ops_notification_receipt" to "hotel_worker"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "ops_shift_handover", "ops_notification", "ops_notification_receipt" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `revoke select, insert, update, delete on "ops_shift_handover", "ops_notification", "ops_notification_receipt" from "hotel_test"`,
    );
    this.addSql(
      `revoke select on "ops_shift_handover", "ops_notification", "ops_notification_receipt" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select, insert on "ops_shift_handover", "ops_notification", "ops_notification_receipt" from "hotel_api"`,
    );
    for (const table of [
      'ops_shift_handover',
      'ops_notification',
      'ops_notification_receipt',
    ]) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop table if exists "${table}" cascade`);
    }
  }
}
