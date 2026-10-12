import { Migration } from '@mikro-orm/migrations';

/**
 * P12-03 hardening: PostgreSQL grants EXECUTE on new functions to PUBLIC by
 * default. Platform helpers already re-validate the active platform actor (and
 * support grants) inside, but least privilege keeps execution limited to the
 * operating roles explicitly granted in the P12 migrations. The functions
 * themselves and their grants to hotel_api/hotel_worker/hotel_test are
 * untouched.
 */
export class Migration20260917070000_platform_function_hardening extends Migration {
  private readonly signatures = [
    'public.is_active_platform_staff(uuid)',
    'public.platform_consume_usage(uuid, text, bigint)',
    'public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, uuid)',
    'public.platform_create_tenant(uuid, text, text, uuid)',
    'public.platform_lifecycle_snapshot(uuid, uuid)',
    'public.platform_set_tenant_status(uuid, text, uuid)',
    'public.platform_stop_tenant_sales(uuid, uuid, text)',
    'public.platform_resume_tenant_sales(uuid, uuid)',
    'public.platform_support_tenant_profile(uuid, uuid)',
    'public.platform_support_tenant_audit(uuid, uuid, int)',
  ];

  override async up(): Promise<void> {
    for (const signature of this.signatures)
      this.addSql(`revoke execute on function ${signature} from public`);
  }

  override async down(): Promise<void> {
    for (const signature of this.signatures)
      this.addSql(`grant execute on function ${signature} to public`);
  }
}
