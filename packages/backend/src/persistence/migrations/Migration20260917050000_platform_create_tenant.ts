import { Migration } from '@mikro-orm/migrations';

/**
 * P12-02 fix: `hotel_api` intentionally has SELECT-only on `tenant`, so
 * platform onboarding cannot insert the tenant row directly. Tenant creation
 * goes through a security-definer helper that only accepts an active platform
 * staff actor, keeping direct tenant INSERT out of the operating role while
 * the remaining onboarding writes stay in the tenant-scoped transaction.
 */
export class Migration20260917050000_platform_create_tenant extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function public.platform_create_tenant(
        p_id uuid,
        p_name text,
        p_slug text,
        p_actor uuid
      )
      returns uuid
      language plpgsql
      security definer
      set search_path = public
      as $$
      begin
        if not public.is_active_platform_staff(p_actor) then
          raise exception 'platform_lifecycle_actor_denied' using errcode = '42501';
        end if;
        if p_name is null or length(trim(p_name)) < 2 or length(p_name) > 200 then
          raise exception 'platform_tenant_name_invalid' using errcode = '23514';
        end if;
        if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
          raise exception 'platform_tenant_slug_invalid' using errcode = '23514';
        end if;
        insert into "tenant" ("id", "name", "slug", "status")
        values (p_id, trim(p_name), p_slug, 'ACTIVE');
        return p_id;
      end
      $$
    `);
    this.addSql(
      `grant execute on function public.platform_create_tenant(uuid, text, text, uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_create_tenant(uuid, text, text, uuid) to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop function if exists public.platform_create_tenant(uuid, text, text, uuid)`,
    );
  }
}
