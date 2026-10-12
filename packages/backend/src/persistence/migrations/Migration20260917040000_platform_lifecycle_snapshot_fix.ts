import { Migration } from '@mikro-orm/migrations';

/**
 * P12-02 fix: the aggregate lifecycle snapshot referenced `reservation.status`
 * (the column is `state`) and used commitment states that do not exist; the
 * snapshot helper is replaced with the correct open-reservation/commitment
 * definitions. The migration that introduced it is untouched.
 */
export class Migration20260917040000_platform_lifecycle_snapshot_fix extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function public.platform_lifecycle_snapshot(
        p_tenant uuid,
        p_actor uuid
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_snapshot jsonb;
      begin
        if not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        select jsonb_build_object(
          'writer', 'PMS',
          'captured_at', now(),
          'properties', (select count(*) from "property" where "tenant_id" = p_tenant),
          'resources', (select count(*) from "resource" where "tenant_id" = p_tenant),
          'connections_total', (select count(*) from "distribution_connection" where "tenant_id" = p_tenant),
          'connections_active', (select count(*) from "distribution_connection" where "tenant_id" = p_tenant and "status" = 'ACTIVE'),
          'exposures_active', (select count(*) from "exposure" where "tenant_id" = p_tenant and "state" in ('RESERVED', 'PUBLISHING', 'ACTIVE', 'WITHDRAWING', 'RECONCILING')),
          'exposures_unknown', (select count(*) from "exposure" where "tenant_id" = p_tenant and "state" = 'UNKNOWN'),
          'commitments_active', (select count(*) from "commitment" where "tenant_id" = p_tenant and "state" in ('ACTIVE', 'CONVERTED')),
          'reservations_open', (select count(*) from "reservation" where "tenant_id" = p_tenant and "state" in ('INQUIRY', 'TENTATIVE', 'WAITLIST', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_HOUSE', 'PARTIALLY_IN_HOUSE')),
          'stays_in_house', (select count(*) from "stay_segment" where "tenant_id" = p_tenant and "state" = 'IN_HOUSE'),
          'journal_rows', (select count(*) from "journal" where "tenant_id" = p_tenant),
          'folios', (select count(*) from "folio" where "tenant_id" = p_tenant)
        ) into v_snapshot;
        return v_snapshot;
      end
      $$
    `);
  }

  override async down(): Promise<void> {
    // No-op: the corrected definition is the intended V1 shape.
  }
}
