import { Migration } from '@mikro-orm/migrations';

export class Migration20260921180000_composition_period_allow_single_day extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "composition_version"
        drop constraint if exists "composition_version_period_check"
    `);
    this.addSql(`
      alter table "composition_version"
        add constraint "composition_version_period_check"
        check ("effective_to" is null or "effective_to" >= "effective_from")
    `);
  }

  override async down(): Promise<void> {
    // Forward-only: restoring the strict ">" check would fail on rows written
    // with a single-day window after this migration. Restore from a backup
    // instead. See docs/execution/SET-06-rollback-plan.md.
    throw new Error(
      'Migration20260921180000 is forward-only: a dated change may legally close a version to a single inclusive day. Restoring requires a database restore, not down(). See docs/execution/SET-06-rollback-plan.md.',
    );
  }
}
