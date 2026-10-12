import { Migration } from '@mikro-orm/migrations';

export class Migration20260914300000_composition_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "resource"
        add column "housekeeping_state" varchar(16) not null default 'CLEAN',
        add column "maintenance_state" varchar(16) not null default 'NONE'
    `);
    this.addSql(`
      alter table "resource"
        add constraint "resource_housekeeping_check"
        check ("housekeeping_state" in ('CLEAN', 'DIRTY', 'INSPECTED'))
    `);
    this.addSql(`
      alter table "resource"
        add constraint "resource_maintenance_check"
        check ("maintenance_state" in ('NONE', 'OOO', 'OOS'))
    `);

    this.addSql(`
      create table "composition_version" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "product_id" uuid not null,
        "version_number" integer not null,
        "effective_from" date not null,
        "effective_to" date,
        "status" varchar(16) not null default 'DRAFT',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "composition_version_status_check" check ("status" in ('DRAFT', 'ACTIVE', 'RETIRED')),
        constraint "composition_version_period_check" check ("effective_to" is null or "effective_to" > "effective_from"),
        constraint "composition_version_number_unique" unique ("tenant_id", "property_id", "product_id", "version_number"),
        constraint "composition_version_scope_unique" unique ("id", "property_id", "tenant_id"),
        constraint "composition_version_product_fk"
          foreign key ("product_id", "property_id", "tenant_id")
          references "product" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "composition_version_property_fk"
          foreign key ("property_id", "tenant_id")
          references "property" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "composition_version_product_idx" on "composition_version" ("tenant_id", "property_id", "product_id", "status")`,
    );

    this.addSql(`
      create table "composition_edge" (
        "id" uuid primary key default gen_random_uuid(),
        "version_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "position" integer not null,
        "child_kind" varchar(16) not null,
        "resource_id" uuid,
        "child_version_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "composition_edge_kind_check" check ("child_kind" in ('RESOURCE', 'COMPOSITION')),
        constraint "composition_edge_target_check" check (
          ("child_kind" = 'RESOURCE' and "resource_id" is not null and "child_version_id" is null)
          or ("child_kind" = 'COMPOSITION' and "child_version_id" is not null and "resource_id" is null)
        ),
        constraint "composition_edge_self_check" check (
          "child_version_id" is null or "child_version_id" <> "version_id"
        ),
        constraint "composition_edge_position_unique" unique ("version_id", "position"),
        constraint "composition_edge_version_fk"
          foreign key ("version_id", "property_id", "tenant_id")
          references "composition_version" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "composition_edge_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict,
        constraint "composition_edge_child_fk"
          foreign key ("child_version_id", "property_id", "tenant_id")
          references "composition_version" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "composition_leaf" (
        "version_id" uuid not null,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "resource_id" uuid not null,
        "depth" integer not null,
        "created_at" timestamptz not null default now(),
        constraint "composition_leaf_pk" primary key ("version_id", "resource_id"),
        constraint "composition_leaf_depth_check" check ("depth" >= 1),        constraint "composition_leaf_version_fk"
          foreign key ("version_id", "property_id", "tenant_id")
          references "composition_version" ("id", "property_id", "tenant_id") on delete cascade,
        constraint "composition_leaf_resource_fk"
          foreign key ("resource_id", "property_id", "tenant_id")
          references "resource" ("id", "property_id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create or replace function public.prevent_composition_change()
      returns trigger
      language plpgsql
      as $$
      declare
        target uuid;
      begin
        if tg_op = 'DELETE' then
          target := old."version_id";
        else
          target := new."version_id";
        end if;
        if exists (
          select 1 from "composition_version" v
           where v."id" = target and v."status" <> 'DRAFT'
        ) then
          raise exception 'composition version is immutable once activated'
            using errcode = '23514';
        end if;
        if tg_op = 'DELETE' then
          return old;
        end if;
        return new;
      end
      $$
    `);

    for (const table of ['composition_edge', 'composition_leaf']) {
      this.addSql(`
        create trigger "prevent_composition_change"
        before insert or update or delete on "${table}"
        for each row execute function public.prevent_composition_change()
      `);
    }

    for (const table of [
      'composition_version',
      'composition_edge',
      'composition_leaf',
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

    this.addSql(`
      grant select, insert, update, delete on
        "composition_version", "composition_edge", "composition_leaf"
      to "hotel_api"
    `);
    this.addSql(
      `grant select on "composition_version", "composition_edge", "composition_leaf" to "hotel_worker"`,
    );
    this.addSql(`
      grant select, insert, update, delete on
        "composition_version", "composition_edge", "composition_leaf"
      to "hotel_test"
    `);

    this.addSql(`
      insert into "permission" ("code", "description_key")
      values ('composition.manage', 'permissions.composition.manage')
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", 'composition.manage'
        from "role" r
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `delete from "role_permission" where "permission_code" = 'composition.manage'`,
    );
    this.addSql(`delete from "permission" where "code" = 'composition.manage'`);
    this.addSql(`
      revoke select, insert, update, delete on
        "composition_version", "composition_edge", "composition_leaf"
      from "hotel_api"
    `);
    this.addSql(
      `revoke select on "composition_version", "composition_edge", "composition_leaf" from "hotel_worker"`,
    );
    this.addSql(`
      revoke select, insert, update, delete on
        "composition_version", "composition_edge", "composition_leaf"
      from "hotel_test"
    `);
    for (const table of [
      'composition_version',
      'composition_edge',
      'composition_leaf',
    ]) {
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    }
    for (const table of ['composition_edge', 'composition_leaf'])
      this.addSql(
        `drop trigger if exists "prevent_composition_change" on "${table}"`,
      );
    this.addSql(`drop function if exists public.prevent_composition_change()`);
    this.addSql(`drop table if exists "composition_leaf"`);
    this.addSql(`drop table if exists "composition_edge"`);
    this.addSql(`drop table if exists "composition_version"`);
    this.addSql(
      `alter table "resource" drop constraint if exists "resource_housekeeping_check"`,
    );
    this.addSql(
      `alter table "resource" drop constraint if exists "resource_maintenance_check"`,
    );
    this.addSql(`
      alter table "resource"
        drop column if exists "housekeeping_state",
        drop column if exists "maintenance_state"
    `);
  }
}
