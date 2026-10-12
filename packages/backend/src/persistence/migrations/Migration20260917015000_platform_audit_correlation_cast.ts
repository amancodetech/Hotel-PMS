import { Migration } from '@mikro-orm/migrations';

/**
 * P12-01 fix: `audit_event.correlation_id` is `uuid`, while the platform
 * tenant-audit helper was declared with a `text` correlation parameter, so
 * every platform write that mirrored its audit into the tenant trail failed
 * with a datatype mismatch. This migration replaces the helper with a typed
 * `uuid` parameter; the migration that introduced it is untouched.
 */
export class Migration20260917015000_platform_audit_correlation_cast extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `drop function if exists public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, text)`,
    );
    this.addSql(`
      create or replace function public.platform_record_tenant_audit(
        p_tenant uuid,
        p_actor uuid,
        p_actor_label text,
        p_action text,
        p_resource_type text,
        p_resource_id uuid,
        p_outcome text,
        p_before jsonb,
        p_after jsonb,
        p_reason text,
        p_correlation uuid
      )
      returns uuid
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_id uuid;
      begin
        if not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_audit_actor_denied' using errcode = '42501';
        end if;
        insert into "audit_event" (
          "tenant_id", "actor_type", "actor_id", "actor_label", "action",
          "resource_type", "resource_id", "outcome", "before_safe",
          "after_safe", "reason", "correlation_id"
        ) values (
          p_tenant, 'USER', p_actor, p_actor_label, p_action,
          p_resource_type, p_resource_id, p_outcome, p_before,
          p_after, p_reason, p_correlation
        )
        returning "id" into v_id;
        return v_id;
      end
      $$
    `);
    this.addSql(
      `grant execute on function public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, uuid) to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop function if exists public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, uuid)`,
    );
  }
}
