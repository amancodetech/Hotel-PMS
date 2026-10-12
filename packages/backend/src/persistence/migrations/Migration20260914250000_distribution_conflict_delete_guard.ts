import { Migration } from '@mikro-orm/migrations';

export class Migration20260914250000_distribution_conflict_delete_guard extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function public.distribution_conflict_delete_guard()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, public
      as $$
      begin
        if old."resolution" is distinct from 'RELEASED' then
          raise exception
            'distribution conflict % is still quarantined; release it before deletion',
            old."id" using errcode = '23514';
        end if;
        return old;
      end
      $$
    `);
    this.addSql(
      `revoke all on function public.distribution_conflict_delete_guard() from public`,
    );
    this.addSql(`
      create trigger "distribution_conflict_delete_guard"
      before delete on "distribution_consistency_conflict"
      for each row execute function public.distribution_conflict_delete_guard()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists "distribution_conflict_delete_guard" on "distribution_consistency_conflict"`,
    );
    this.addSql(
      `drop function if exists public.distribution_conflict_delete_guard()`,
    );
  }
}
