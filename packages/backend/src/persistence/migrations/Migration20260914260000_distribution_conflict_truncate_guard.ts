import { Migration } from '@mikro-orm/migrations';

export class Migration20260914260000_distribution_conflict_truncate_guard extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function public.distribution_conflict_truncate_guard()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, public
      as $$
      begin
        if exists (
          select 1 from public."distribution_consistency_conflict"
           where "resolution" is distinct from 'RELEASED'
        ) then
          raise exception
            'distribution conflict ledger still holds quarantined rows; release them before truncation'
            using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(
      `revoke all on function public.distribution_conflict_truncate_guard() from public`,
    );
    this.addSql(`
      create trigger "distribution_conflict_truncate_guard"
      before truncate on "distribution_consistency_conflict"
      for each statement execute function public.distribution_conflict_truncate_guard()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists "distribution_conflict_truncate_guard" on "distribution_consistency_conflict"`,
    );
    this.addSql(
      `drop function if exists public.distribution_conflict_truncate_guard()`,
    );
  }
}
