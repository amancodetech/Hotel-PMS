import { Migration } from '@mikro-orm/migrations';

export class Migration20260922100000_composition_revival_provenance extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "composition_status_audit" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "composition_version_id" uuid not null,
        "from_status" varchar(16) not null,
        "to_status" varchar(16) not null,
        "reason" varchar(64) not null,
        "migration" varchar(64),
        "created_at" timestamptz not null default now()
      )
    `);
    this.addSql(`
      create index "composition_status_audit_version_idx"
        on "composition_status_audit" ("composition_version_id", "created_at" desc)
    `);
    this.addSql(
      `alter table "composition_status_audit" enable row level security`,
    );
    this.addSql(
      `alter table "composition_status_audit" force row level security`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "composition_status_audit"
        using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
        with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "composition_status_audit"
      for each row execute function public.prevent_tenant_id_change()
    `);
    this.addSql(
      `grant select on "composition_status_audit" to "hotel_api", "hotel_worker"`,
    );
    this.addSql(
      `grant select, insert, delete on "composition_status_audit" to "hotel_test"`,
    );

    // Revival is a migration-only operation. A plain RETIRED -> ACTIVE update
    // is rejected unless the composition id is recorded as approved in the
    // provenance table; the application never revives versions.
    this.addSql(`
      create function public.guard_composition_revival() returns trigger as $$
      begin
        if old."status" = 'RETIRED' and new."status" = 'ACTIVE' then
          if not exists (
            select 1
              from "composition_status_audit" a
             where a."composition_version_id" = new."id"
               and a."to_status" = 'ACTIVE'
          ) then
            raise exception 'composition revival requires a composition_status_audit approval entry'
              using errcode = '23514';
          end if;
        end if;
        return new;
      end
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger "guard_composition_revival"
      before update on "composition_version"
      for each row execute function public.guard_composition_revival()
    `);

    // Repair: migration 170000 revived every RETIRED row that overlapped an
    // ACTIVE row, including rows deliberately retired through the dated
    // change service. Trusted provenance for a deliberate retirement is the
    // audit event written by that service (before_safe.composition_id plus
    // after_safe.retired = true). Rows that were only retired by migration
    // 160000 have no such event and stay ACTIVE under the relaxed model.
    this.addSql(`
      with revived as (
        select v."id", v."tenant_id", v."property_id"
          from "composition_version" v
         where v."status" = 'ACTIVE'
           and exists (
             select 1
               from "audit_event" a
              where a."tenant_id" = v."tenant_id"
                and a."property_id" = v."property_id"
                and a."action" = 'composition.superseded'
                and a."after_safe" ->> 'retired' = 'true'
                and a."before_safe" ->> 'composition_id' = v."id"::text
           )
           and exists (
             select 1
               from "composition_version" o
              where o."product_id" = v."product_id"
                and o."id" <> v."id"
                and o."status" = 'ACTIVE'
                and daterange(o."effective_from", coalesce(o."effective_to", 'infinity'::date), '[]')
                 && daterange(v."effective_from", coalesce(v."effective_to", 'infinity'::date), '[]')
           )
      ),
      logged as (
        insert into "composition_status_audit"
          ("tenant_id", "property_id", "composition_version_id",
           "from_status", "to_status", "reason", "migration")
        select "tenant_id", "property_id", "id",
               'ACTIVE', 'RETIRED', 'repair_intended_retirement', '170000'
          from revived
        returning "composition_version_id"
      )
      update "composition_version" v
         set "status" = 'RETIRED',
             "version" = v."version" + 1,
             "updated_at" = now()
        from logged l
       where v."id" = l."composition_version_id"
         and v."status" = 'ACTIVE'
    `);
  }

  override async down(): Promise<void> {
    throw new Error(
      'Migration20260922100000 is forward-only: the provenance table and the revival guard cannot be rolled back without losing the repair record. Restore from a backup instead. See docs/execution/SET-06-rollback-plan.md.',
    );
  }
}
