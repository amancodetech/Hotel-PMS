import { Migration } from '@mikro-orm/migrations';

const permissionCodes = [
  'task.read',
  'task.manage',
  'task.complete',
  'task.inspect',
];

export class Migration20260916090000_operations_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "resource"
        drop constraint if exists "resource_housekeeping_check"
    `);
    this.addSql(`
      alter table "resource"
        add constraint "resource_housekeeping_check"
        check ("housekeeping_state" in ('CLEAN', 'DIRTY', 'CLEANING', 'INSPECTED'))
    `);

    this.addSql(`
      create table "property_operations_policy" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "inspection_required" boolean not null default false,
        "long_stay_clean_interval_days" integer,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "property_operations_policy_interval_check"
          check ("long_stay_clean_interval_days" is null
                 or ("long_stay_clean_interval_days" between 1 and 365)),
        constraint "property_operations_policy_version_check" check ("version" >= 1),
        constraint "property_operations_policy_scope_unique"
          unique ("id", "property_id", "tenant_id"),
        constraint "property_operations_policy_property_unique"
          unique ("tenant_id", "property_id"),
        constraint "property_operations_policy_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "ops_task" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "type" varchar(16) not null,
        "status" varchar(16) not null default 'PENDING',
        "source_event_id" uuid,
        "source_event_type" varchar(32),
        "resource_id" uuid,
        "item_id" uuid,
        "reservation_id" uuid,
        "description" text,
        "priority" integer not null default 0,
        "due_date" date,
        "policy_version" integer,
        "assignee_membership_id" uuid,
        "created_by_membership_id" uuid,
        "clean_started_at" timestamptz,
        "clean_completed_at" timestamptz,
        "inspected_at" timestamptz,
        "inspected_by_membership_id" uuid,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "ops_task_type_check"
          check ("type" in ('HOUSEKEEPING', 'GUEST_REQUEST')),
        constraint "ops_task_status_check"
          check ("status" in ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'CLEAN', 'INSPECTED', 'CANCELLED')),
        constraint "ops_task_priority_check" check ("priority" between 0 and 9),
        constraint "ops_task_version_check" check ("version" >= 1),
        constraint "ops_task_source_check"
          check (("source_event_id" is null) = ("source_event_type" is null)),
        constraint "ops_task_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "ops_task_stay_scope_check"
          check ("item_id" is null or "reservation_id" is not null),
        constraint "ops_task_source_event_fk"
          foreign key ("source_event_id", "property_id", "tenant_id")
          references "stay_event" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_task_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_task_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_task_reservation_fk"
          foreign key ("reservation_id", "property_id", "tenant_id")
          references "reservation" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_task_assignee_fk"
          foreign key ("assignee_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_task_inspector_fk"
          foreign key ("inspected_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict,
        constraint "ops_task_creator_fk"
          foreign key ("created_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create unique index "ops_task_source_unique"
        on "ops_task" ("tenant_id", "property_id", "source_event_id")
        where "source_event_id" is not null
    `);
    this.addSql(`
      create index "ops_task_board_idx"
        on "ops_task" ("tenant_id", "property_id", "status", "due_date")
    `);
    this.addSql(`
      create index "ops_task_assignee_idx"
        on "ops_task" ("tenant_id", "assignee_membership_id", "status")
    `);
    this.addSql(`
      create index "ops_task_item_idx"
        on "ops_task" ("tenant_id", "property_id", "item_id", "created_at")
    `);

    this.addSql(`
      create table "ops_dnd_log" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "item_id" uuid,
        "state" varchar(16) not null default 'ACTIVE',
        "note" text not null,
        "follow_up_at" timestamptz,
        "follow_up_note" text,
        "follow_up_attempt_at" timestamptz,
        "created_by_membership_id" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "ops_dnd_log_state_check" check ("state" in ('ACTIVE', 'FOLLOWED_UP')),
        constraint "ops_dnd_log_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "ops_dnd_log_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_dnd_log_item_fk"
          foreign key ("item_id", "property_id", "tenant_id")
          references "reservation_item" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "ops_dnd_log_creator_fk"
          foreign key ("created_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(`
      create index "ops_dnd_log_resource_idx"
        on "ops_dnd_log" ("tenant_id", "property_id", "resource_id", "created_at")
    `);

    for (const table of [
      'property_operations_policy',
      'ops_task',
      'ops_dnd_log',
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
      `grant select, insert, update on "property_operations_policy", "ops_task", "ops_dnd_log" to "hotel_api"`,
    );
    this.addSql(
      `grant select on "property_operations_policy", "ops_task", "ops_dnd_log" to "hotel_worker"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "property_operations_policy", "ops_task", "ops_dnd_log" to "hotel_test"`,
    );

    const permissionValues = permissionCodes
      .map((code) => `('${code}', 'permissions.${code}')`)
      .join(',\n        ');
    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ${permissionValues}
      on conflict ("code") do nothing
    `);
    const permissionList = permissionCodes
      .map((code) => `'${code}'`)
      .join(', ');
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", p."code"
        from "role" r
        join "permission" p on p."code" in (${permissionList})
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    const permissionList = permissionCodes
      .map((code) => `'${code}'`)
      .join(', ');
    this.addSql(`
      delete from "role_permission"
       where "permission_code" in (${permissionList})
    `);
    this.addSql(`
      delete from "permission" where "code" in (${permissionList})
    `);
    this.addSql(
      `revoke select, insert, update, delete on "property_operations_policy", "ops_task", "ops_dnd_log" from "hotel_test"`,
    );
    this.addSql(
      `revoke select on "property_operations_policy", "ops_task", "ops_dnd_log" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select, insert, update on "property_operations_policy", "ops_task", "ops_dnd_log" from "hotel_api"`,
    );
    for (const table of [
      'property_operations_policy',
      'ops_task',
      'ops_dnd_log',
    ]) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop table if exists "${table}" cascade`);
    }
    this.addSql(`
      alter table "resource"
        drop constraint if exists "resource_housekeeping_check"
    `);
    this.addSql(`
      alter table "resource"
        add constraint "resource_housekeeping_check"
        check ("housekeeping_state" in ('CLEAN', 'DIRTY', 'INSPECTED'))
    `);
  }
}
