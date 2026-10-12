import { Migration } from '@mikro-orm/migrations';

export class Migration20260921170000_composition_overlap_relax extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "composition_version"
        drop constraint if exists "composition_version_active_no_overlap"
    `);
    this.addSql(`
      update "composition_version" v
         set "status" = 'ACTIVE',
             "version" = "version" + 1,
             "updated_at" = now()
       where v."status" = 'RETIRED'
         and exists (
           select 1
             from "composition_version" o
            where o."product_id" = v."product_id"
              and o."id" <> v."id"
              and o."status" = 'ACTIVE'
              and daterange(o."effective_from", coalesce(o."effective_to", 'infinity'::date), '[]')
               && daterange(v."effective_from", coalesce(v."effective_to", 'infinity'::date), '[]')
         )
    `);
  }

  override async down(): Promise<void> {
    // Forward-only. The revival of migration-retired rows cannot be undone by
    // shaping schema: restore from a pre-160000 backup instead.
    // See docs/execution/SET-06-rollback-plan.md.
    throw new Error(
      'Migration20260921170000 is forward-only: it revived RETIRED composition rows and dropped the overlap guard. Restoring requires a database restore, not down(). See docs/execution/SET-06-rollback-plan.md.',
    );
  }
}
