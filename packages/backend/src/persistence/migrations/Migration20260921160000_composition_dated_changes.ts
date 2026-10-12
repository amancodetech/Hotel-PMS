import { Migration } from '@mikro-orm/migrations';

export class Migration20260921160000_composition_dated_changes extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$
      declare
        target uuid;
      begin
        for target in
          select a."id"
            from "composition_version" a
            join "composition_version" b
              on b."product_id" = a."product_id"
             and b."status" = 'ACTIVE'
             and b."id" <> a."id"
             and (
               b."version_number" > a."version_number"
               or (b."version_number" = a."version_number" and b."created_at" > a."created_at")
               or (
                 b."version_number" = a."version_number"
                 and b."created_at" = a."created_at"
                 and b."id" > a."id"
               )
             )
             and daterange(a."effective_from", coalesce(a."effective_to", 'infinity'::date), '[]')
              && daterange(b."effective_from", coalesce(b."effective_to", 'infinity'::date), '[]')
           where a."status" = 'ACTIVE'
        loop
          update "composition_version"
             set "status" = 'RETIRED',
                 "version" = "version" + 1,
                 "updated_at" = now()
           where "id" = target and "status" = 'ACTIVE';
        end loop;
      end $$;
    `);
    this.addSql(`
      alter table "composition_version"
        add constraint "composition_version_active_no_overlap"
        exclude using gist (
          "product_id" with =,
          daterange("effective_from", coalesce("effective_to", 'infinity'::date), '[]') with &&
        ) where ("status" = 'ACTIVE')
    `);
    this.addSql(`
      create index "composition_version_property_window_idx"
        on "composition_version" ("tenant_id", "property_id", "effective_from")
        where "status" = 'ACTIVE'
    `);
  }

  override async down(): Promise<void> {
    // Forward-only: this migration retired overlapping ACTIVE rows (data), and
    // a silent schema rollback would leave the migration log behind the data.
    // See docs/execution/SET-06-rollback-plan.md (restore from a pre-160000
    // backup, then replay migrations forward).
    throw new Error(
      'Migration20260921160000 is forward-only: restoring the overlap guard or the strict period check requires a database restore, not down(). See docs/execution/SET-06-rollback-plan.md.',
    );
  }
}
