import { Migration } from '@mikro-orm/migrations';

export class Migration20260913220000_work_discovery_recovery extends Migration {
  override async up(): Promise<void> {
    this.addSql(`drop function if exists public.distribution_work_tenants()`);
    this.addSql(`
      create function public.distribution_work_tenants(p_max_attempts integer default 4)
      returns table (tenant_id uuid)
      language sql
      security definer
      set search_path = public
      as $$
        select tenant_id
          from (
            select c.tenant_id
              from distribution_inbox_revision i
              join distribution_connection c on c.id = i.connection_id
             where i.ack_state in ('PENDING', 'UNKNOWN')
               and (
                 (i.ack_attempt_count < p_max_attempts
                   and (i.ack_next_attempt_at is null or i.ack_next_attempt_at <= now())
                   and (i.ack_lease_expires_at is null or i.ack_lease_expires_at <= now()))
                 or (i.ack_lease_expires_at is not null and i.ack_lease_expires_at <= now())
                 or (i.ack_attempt_count >= p_max_attempts
                     and i.ack_lease_expires_at is null
                     and i.ack_exception_id is null)
               )
            union
            select o.tenant_id
              from distribution_outbox_event o
             where o.status in ('PENDING', 'LEASED', 'RETRY_SCHEDULED', 'UNKNOWN', 'PARTIAL')
               and o.next_attempt_at <= now()
          ) work
         limit 200
      $$
    `);
    this.addSql(
      `revoke all on function public.distribution_work_tenants(integer) from public`,
    );
    this.addSql(
      `grant execute on function public.distribution_work_tenants(integer) to "hotel_worker"`,
    );
    this.addSql(
      `grant execute on function public.distribution_work_tenants(integer) to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop function if exists public.distribution_work_tenants(integer)`,
    );
  }
}
