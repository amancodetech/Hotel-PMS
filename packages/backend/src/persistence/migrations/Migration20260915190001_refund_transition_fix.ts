import { Migration } from '@mikro-orm/migrations';

/**
 * The original refund transition guard rejected every update while the state
 * stayed RESERVED, which also blocked attaching the independent approval to a
 * freshly reserved refund. This replacement keeps the forward-only state rule
 * (terminal states immutable, no backwards/same-state transitions) while
 * allowing non-state updates on a reserved or pending refund.
 */
export class Migration20260915190001_refund_transition_fix extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function public.assert_refund_transition()
      returns trigger
      language plpgsql
      as $$
      begin
        if old."state" in ('SUCCEEDED', 'FAILED') then
          raise exception 'refund % is already resolved', old."id"
            using errcode = '23514';
        end if;
        if new."state" <> old."state" then
          if not (
            (old."state" = 'RESERVED'
              and new."state" in ('PENDING', 'SUCCEEDED', 'FAILED'))
            or (old."state" = 'PENDING'
              and new."state" in ('SUCCEEDED', 'FAILED'))
          ) then
            raise exception 'refund state must advance'
              using errcode = '23514';
          end if;
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."payment_id" <> old."payment_id"
           or new."folio_id" <> old."folio_id"
           or new."currency" <> old."currency"
           or new."amount" <> old."amount" then
          raise exception 'refund identity is immutable'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      create or replace function public.assert_refund_transition()
      returns trigger
      language plpgsql
      as $$
      begin
        if old."state" in ('SUCCEEDED', 'FAILED') then
          raise exception 'refund % is already resolved', old."id"
            using errcode = '23514';
        end if;
        if new."state" = 'RESERVED'
           or (old."state" = 'PENDING' and new."state" = 'PENDING') then
          raise exception 'refund state must advance'
            using errcode = '23514';
        end if;
        if new."tenant_id" <> old."tenant_id"
           or new."property_id" <> old."property_id"
           or new."payment_id" <> old."payment_id"
           or new."folio_id" <> old."folio_id"
           or new."currency" <> old."currency"
           or new."amount" <> old."amount" then
          raise exception 'refund identity is immutable'
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
  }
}
