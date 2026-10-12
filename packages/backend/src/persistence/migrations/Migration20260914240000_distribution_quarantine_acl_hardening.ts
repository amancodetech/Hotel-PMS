import { Migration } from '@mikro-orm/migrations';

export class Migration20260914240000_distribution_quarantine_acl_hardening extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `revoke all on function public.distribution_conflict_row_tenant(text, uuid) from public`,
    );
    this.addSql(
      `revoke all on function public.distribution_conflict_release_guard() from public`,
    );
    this.addSql(`
      alter table "distribution_consistency_conflict"
        add constraint "distribution_conflict_resolution_check"
        check ("resolution" in ('QUARANTINED_NOT_VALID', 'RELEASED'))
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "distribution_consistency_conflict"
        drop constraint if exists "distribution_conflict_resolution_check"
    `);
    this.addSql(
      `grant execute on function public.distribution_conflict_release_guard() to public`,
    );
    this.addSql(
      `grant execute on function public.distribution_conflict_row_tenant(text, uuid) to public`,
    );
  }
}
