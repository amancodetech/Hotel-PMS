import { Migration } from '@mikro-orm/migrations';

export class Migration20260913230000_distribution_root_tenant_fk_and_quarantine extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create index "distribution_conflict_row_idx" on "distribution_consistency_conflict" ("table_name", "row_id")`,
    );

    const orphanTargets = [
      ['distribution_connection', 'connection'],
      ['distribution_outbox_event', 'outbox event'],
      ['distribution_exception_case', 'exception case'],
      ['distribution_dead_letter', 'dead letter'],
    ] as const;
    for (const [table] of orphanTargets) {
      this.addSql(`
        insert into "distribution_consistency_conflict"
          ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
           "parent_tenant_id", "details_safe")
        select '${table}', s."id", s."tenant_id", 'tenant', s."tenant_id", null,
               jsonb_build_object('reason', 'orphan_tenant')
          from "${table}" s
         where not exists (select 1 from "tenant" t where t."id" = s."tenant_id")
           and not exists (
             select 1 from "distribution_consistency_conflict" c
              where c."table_name" = '${table}' and c."row_id" = s."id"
                and c."details_safe" ->> 'reason' = 'orphan_tenant'
           )
      `);
    }

    const rootConstraints: Array<[string, string]> = [
      ['distribution_connection', 'distribution_connection_tenant_fk'],
      ['distribution_outbox_event', 'distribution_outbox_tenant_fk'],
      ['distribution_exception_case', 'distribution_exception_tenant_fk'],
      ['distribution_dead_letter', 'distribution_dead_letter_tenant_fk'],
    ];
    for (const [table, name] of rootConstraints)
      this.addSql(
        `alter table "${table}" add constraint "${name}" foreign key ("tenant_id") references "tenant" ("id") not valid`,
      );
    for (const [table, name] of rootConstraints) {
      this.addSql(`
        do $$
        begin
          if not exists (
            select 1 from "distribution_consistency_conflict"
             where "table_name" = '${table}'
               and "details_safe" ->> 'reason' = 'orphan_tenant'
          ) then
            alter table "${table}" validate constraint "${name}";
          end if;
        end
        $$
      `);
    }

    this.addSql(
      `grant select on "distribution_consistency_conflict" to "hotel_worker"`,
    );
    this.addSql(
      `grant select on "distribution_consistency_conflict" to "hotel_test"`,
    );

    const directQuarantinePolicies = [
      'distribution_outbox_event',
      'distribution_exception_case',
      'distribution_dead_letter',
    ];
    for (const table of directQuarantinePolicies) {
      this.addSql(`drop policy "tenant_isolation" on "${table}"`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (
            "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
            and not exists (
              select 1 from "distribution_consistency_conflict" c
               where c."table_name" = '${table}'
                 and c."row_id" = "${table}"."id"
                 and c."resolution" = 'QUARANTINED_NOT_VALID'
            )
          )
          with check (
            "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
      `);
    }

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_inbox_revision"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_inbox_revision"
        using (
          exists (
            select 1 from "distribution_connection" p
             where p."id" = "distribution_inbox_revision"."connection_id"
               and p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_inbox_revision'
               and c."row_id" = "distribution_inbox_revision"."id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
        )
        with check (
          exists (
            select 1 from "distribution_connection" p
             where p."id" = "distribution_inbox_revision"."connection_id"
               and p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);

    this.addSql(`drop policy "tenant_isolation" on "distribution_dedup_key"`);
    this.addSql(`
      create policy "tenant_isolation" on "distribution_dedup_key"
        using (
          exists (
            select 1
              from "distribution_inbox_revision" i
              join "distribution_connection" c on c."id" = i."connection_id"
             where i."id" = "distribution_dedup_key"."inbox_revision_id"
               and c."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_dedup_key'
               and c."row_id" = "distribution_dedup_key"."id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_inbox_revision'
               and c."row_id" = "distribution_dedup_key"."inbox_revision_id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
        )
        with check (
          exists (
            select 1
              from "distribution_inbox_revision" i
              join "distribution_connection" c on c."id" = i."connection_id"
             where i."id" = "distribution_dedup_key"."inbox_revision_id"
               and c."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_sync_attempt"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_sync_attempt"
        using (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_sync_attempt'
               and c."row_id" = "distribution_sync_attempt"."id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_outbox_event'
               and c."row_id" = "distribution_sync_attempt"."outbox_id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
        )
        with check (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);

    this.addSql(
      `drop function if exists public.distribution_work_tenants(integer)`,
    );
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
               and not exists (
                 select 1 from distribution_consistency_conflict q
                  where q.table_name = 'distribution_inbox_revision'
                    and q.row_id = i.id
                    and q.resolution = 'QUARANTINED_NOT_VALID'
               )
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
               and not exists (
                 select 1 from distribution_consistency_conflict q
                  where q.table_name = 'distribution_outbox_event'
                    and q.row_id = o.id
                    and q.resolution = 'QUARANTINED_NOT_VALID'
               )
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
      `drop policy "tenant_isolation" on "distribution_inbox_revision"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_inbox_revision"
        using (
          exists (
            select 1 from "distribution_connection" p
             where p."id" = "distribution_inbox_revision"."connection_id"
               and p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
        with check (
          exists (
            select 1 from "distribution_connection" p
             where p."id" = "distribution_inbox_revision"."connection_id"
               and p."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);
    this.addSql(`drop policy "tenant_isolation" on "distribution_dedup_key"`);
    this.addSql(`
      create policy "tenant_isolation" on "distribution_dedup_key"
        using (
          exists (
            select 1
              from "distribution_inbox_revision" i
              join "distribution_connection" c on c."id" = i."connection_id"
             where i."id" = "distribution_dedup_key"."inbox_revision_id"
               and c."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
        with check (
          exists (
            select 1
              from "distribution_inbox_revision" i
              join "distribution_connection" c on c."id" = i."connection_id"
             where i."id" = "distribution_dedup_key"."inbox_revision_id"
               and c."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);
    this.addSql(
      `drop policy "tenant_isolation" on "distribution_sync_attempt"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_sync_attempt"
        using (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
        with check (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);
    for (const table of [
      'distribution_outbox_event',
      'distribution_exception_case',
      'distribution_dead_letter',
    ]) {
      this.addSql(`drop policy "tenant_isolation" on "${table}"`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (
            "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
          with check (
            "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
      `);
    }
    this.addSql(
      `drop function if exists public.distribution_work_tenants(integer)`,
    );
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
    this.addSql(
      `revoke select on "distribution_consistency_conflict" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select on "distribution_consistency_conflict" from "hotel_test"`,
    );
    for (const [table, name] of [
      ['distribution_connection', 'distribution_connection_tenant_fk'],
      ['distribution_outbox_event', 'distribution_outbox_tenant_fk'],
      ['distribution_exception_case', 'distribution_exception_tenant_fk'],
      ['distribution_dead_letter', 'distribution_dead_letter_tenant_fk'],
    ] as const)
      this.addSql(`alter table "${table}" drop constraint if exists "${name}"`);
    this.addSql(`drop index if exists "distribution_conflict_row_idx"`);
  }
}
