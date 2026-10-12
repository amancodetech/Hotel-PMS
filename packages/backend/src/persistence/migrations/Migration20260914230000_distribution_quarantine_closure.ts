import { Migration } from '@mikro-orm/migrations';

const ctx = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

export class Migration20260914230000_distribution_quarantine_closure extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function public.distribution_row_quarantined(p_table text, p_row_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = pg_catalog, public
      as $$
        select exists (
          select 1
            from public."distribution_consistency_conflict" c
           where c."table_name" = p_table
             and c."row_id" = p_row_id
             and c."resolution" = 'QUARANTINED_NOT_VALID'
        )
      $$
    `);

    this.addSql(`
      create function public.distribution_quarantined(p_table text, p_row_id uuid)
      returns boolean
      language plpgsql
      stable
      security definer
      set search_path = pg_catalog, public
      as $$
      declare
        v_connection uuid;
        v_outbox uuid;
        v_inbox uuid;
      begin
        if p_row_id is null then
          return false;
        end if;
        if public.distribution_row_quarantined(p_table, p_row_id) then
          return true;
        end if;
        case p_table
          when 'distribution_connection' then
            return false;
          when 'distribution_outbox_event' then
            select o."connection_id" into v_connection
              from public."distribution_outbox_event" o
             where o."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_connection', v_connection);
          when 'distribution_inbox_revision' then
            select i."connection_id", i."exception_id", i."ack_exception_id"
              into v_connection, v_outbox, v_inbox
              from public."distribution_inbox_revision" i
             where i."id" = p_row_id;
            return public.distribution_quarantined(
                     'distribution_connection', v_connection)
                or public.distribution_row_quarantined(
                     'distribution_exception_case', v_outbox)
                or public.distribution_row_quarantined(
                     'distribution_exception_case', v_inbox);
          when 'distribution_exception_case' then
            select e."connection_id", e."outbox_id", e."inbox_revision_id"
              into v_connection, v_outbox, v_inbox
              from public."distribution_exception_case" e
             where e."id" = p_row_id;
            return public.distribution_quarantined(
                     'distribution_connection', v_connection)
                or public.distribution_quarantined(
                     'distribution_outbox_event', v_outbox)
                or public.distribution_quarantined(
                     'distribution_inbox_revision', v_inbox);
          when 'distribution_dead_letter' then
            select d."connection_id", d."outbox_id"
              into v_connection, v_outbox
              from public."distribution_dead_letter" d
             where d."id" = p_row_id;
            return public.distribution_quarantined(
                     'distribution_connection', v_connection)
                or public.distribution_quarantined(
                     'distribution_outbox_event', v_outbox);
          when 'distribution_sync_attempt' then
            select a."outbox_id" into v_outbox
              from public."distribution_sync_attempt" a
             where a."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_outbox_event', v_outbox);
          when 'distribution_dedup_key' then
            select k."inbox_revision_id" into v_inbox
              from public."distribution_dedup_key" k
             where k."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_inbox_revision', v_inbox);
          when 'distribution_channel_capability' then
            select t."connection_id" into v_connection
              from public."distribution_channel_capability" t
             where t."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_connection', v_connection);
          when 'distribution_mapping_version' then
            select t."connection_id" into v_connection
              from public."distribution_mapping_version" t
             where t."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_connection', v_connection);
          when 'distribution_external_booking' then
            select t."connection_id" into v_connection
              from public."distribution_external_booking" t
             where t."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_connection', v_connection);
          when 'distribution_sync_checkpoint' then
            select t."connection_id" into v_connection
              from public."distribution_sync_checkpoint" t
             where t."id" = p_row_id;
            return public.distribution_quarantined(
              'distribution_connection', v_connection);
          else
            raise exception 'unsupported distribution quarantine lookup: %',
              p_table using errcode = '22023';
        end case;
      end
      $$
    `);

    this.addSql(
      `revoke all on function public.distribution_row_quarantined(text, uuid) from public`,
    );
    this.addSql(
      `revoke all on function public.distribution_quarantined(text, uuid) from public`,
    );
    this.addSql(
      `grant execute on function public.distribution_quarantined(text, uuid) to "hotel_worker"`,
    );
    this.addSql(
      `grant execute on function public.distribution_quarantined(text, uuid) to "hotel_test"`,
    );

    this.addSql(
      `revoke select on "distribution_consistency_conflict" from "hotel_worker"`,
    );
    this.addSql(
      `revoke select on "distribution_consistency_conflict" from "hotel_test"`,
    );
    this.addSql(
      `alter table "distribution_consistency_conflict" enable row level security`,
    );

    this.addSql(`
      alter table "distribution_consistency_conflict"
        add column "resolved_at" timestamptz,
        add column "resolved_by" varchar(200)
    `);

    this.addSql(`
      create function public.distribution_conflict_row_tenant(p_table text, p_row_id uuid)
      returns uuid
      language plpgsql
      stable
      security definer
      set search_path = pg_catalog, public
      as $$
      declare
        v_tenant uuid;
      begin
        case p_table
          when 'distribution_connection' then
            select c."tenant_id" into v_tenant
              from public."distribution_connection" c where c."id" = p_row_id;
          when 'distribution_outbox_event' then
            select o."tenant_id" into v_tenant
              from public."distribution_outbox_event" o where o."id" = p_row_id;
          when 'distribution_inbox_revision' then
            select i."tenant_id" into v_tenant
              from public."distribution_inbox_revision" i where i."id" = p_row_id;
          when 'distribution_exception_case' then
            select e."tenant_id" into v_tenant
              from public."distribution_exception_case" e where e."id" = p_row_id;
          when 'distribution_dead_letter' then
            select d."tenant_id" into v_tenant
              from public."distribution_dead_letter" d where d."id" = p_row_id;
          when 'distribution_external_booking' then
            select b."tenant_id" into v_tenant
              from public."distribution_external_booking" b where b."id" = p_row_id;
          else
            return null;
        end case;
        return v_tenant;
      end
      $$
    `);

    this.addSql(`
      create function public.distribution_conflict_release_guard()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, public
      as $$
      declare
        v_reason text := coalesce(old."details_safe" ->> 'reason', '');
        v_row_tenant uuid;
        v_parent_tenant uuid;
      begin
        if new."resolution" = 'RELEASED'
           and old."resolution" is distinct from 'RELEASED' then
          if v_reason = 'orphan_tenant' then
            v_row_tenant := public.distribution_conflict_row_tenant(
              old."table_name", old."row_id");
            if v_row_tenant is not null
               and not exists (
                 select 1 from public."tenant" t where t."id" = v_row_tenant
               ) then
              raise exception
                'distribution conflict % is still inconsistent', old."id"
                using errcode = '23514';
            end if;
          elsif v_reason = 'tenant_mismatch' then
            v_row_tenant := public.distribution_conflict_row_tenant(
              old."table_name", old."row_id");
            v_parent_tenant := public.distribution_conflict_row_tenant(
              old."parent_table", old."parent_id");
            if v_row_tenant is not null
               and (v_parent_tenant is null
                    or v_parent_tenant <> v_row_tenant) then
              raise exception
                'distribution conflict % is still inconsistent', old."id"
                using errcode = '23514';
            end if;
          elsif v_reason = 'orphan_parent' then
            if exists (
              select 1 from public."distribution_dedup_key" d
               where d."id" = old."row_id"
                 and d."inbox_revision_id" is null
            ) then
              raise exception
                'distribution conflict % is still inconsistent', old."id"
                using errcode = '23514';
            end if;
          else
            raise exception
              'distribution conflict % has no verifiable resolution rule',
              old."id" using errcode = '23514';
          end if;
          new."resolved_at" := coalesce(new."resolved_at", now());
          new."resolved_by" := coalesce(new."resolved_by", current_user);
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger "distribution_conflict_release_guard"
      before update on "distribution_consistency_conflict"
      for each row execute function public.distribution_conflict_release_guard()
    `);

    this.addSql(`drop policy "tenant_isolation" on "distribution_connection"`);
    this.addSql(`
      create policy "tenant_isolation" on "distribution_connection"
        using (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_connection', "id")
        )
        with check (
          "tenant_id" = ${ctx}
        )
    `);

    for (const table of [
      'distribution_channel_capability',
      'distribution_mapping_version',
      'distribution_external_booking',
      'distribution_sync_checkpoint',
    ]) {
      this.addSql(`drop policy "tenant_isolation" on "${table}"`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (
            exists (
              select 1 from "distribution_connection" p
               where p."id" = "${table}"."connection_id"
                 and p."tenant_id" = ${ctx}
            )
            and not public.distribution_quarantined('${table}', "id")
            and not public.distribution_quarantined(
              'distribution_connection', "connection_id")
          )
          with check (
            exists (
              select 1 from "distribution_connection" p
               where p."id" = "${table}"."connection_id"
                 and p."tenant_id" = ${ctx}
            )
            and not public.distribution_quarantined('${table}', "id")
            and not public.distribution_quarantined(
              'distribution_connection', "connection_id")
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
               and p."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_inbox_revision', "id")
        )
        with check (
          exists (
            select 1 from "distribution_connection" p
             where p."id" = "distribution_inbox_revision"."connection_id"
               and p."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_inbox_revision', "id")
        )
    `);

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_outbox_event"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_outbox_event"
        using (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_outbox_event', "id")
        )
        with check (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_connection', "connection_id")
        )
    `);

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_exception_case"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_exception_case"
        using (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_exception_case', "id")
        )
        with check (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_connection', "connection_id")
          and not public.distribution_quarantined(
            'distribution_outbox_event', "outbox_id")
          and not public.distribution_quarantined(
            'distribution_inbox_revision', "inbox_revision_id")
        )
    `);

    this.addSql(`drop policy "tenant_isolation" on "distribution_dead_letter"`);
    this.addSql(`
      create policy "tenant_isolation" on "distribution_dead_letter"
        using (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_dead_letter', "id")
        )
        with check (
          "tenant_id" = ${ctx}
          and not public.distribution_quarantined(
            'distribution_connection', "connection_id")
          and not public.distribution_quarantined(
            'distribution_outbox_event', "outbox_id")
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
               and o."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_sync_attempt', "id")
          and not public.distribution_quarantined(
            'distribution_outbox_event', "outbox_id")
        )
        with check (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_outbox_event', "outbox_id")
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
               and c."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_dedup_key', "id")
          and not public.distribution_quarantined(
            'distribution_inbox_revision', "inbox_revision_id")
        )
        with check (
          exists (
            select 1
              from "distribution_inbox_revision" i
              join "distribution_connection" c on c."id" = i."connection_id"
             where i."id" = "distribution_dedup_key"."inbox_revision_id"
               and c."tenant_id" = ${ctx}
          )
          and not public.distribution_quarantined(
            'distribution_inbox_revision', "inbox_revision_id")
        )
    `);

    this.addSql(`
      create or replace function public.distribution_work_tenants(p_max_attempts integer default 4)
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
               and not public.distribution_quarantined(
                 'distribution_inbox_revision', i.id)
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
               and not public.distribution_quarantined(
                 'distribution_outbox_event', o.id)
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
      `drop trigger if exists "distribution_conflict_release_guard" on "distribution_consistency_conflict"`,
    );
    this.addSql(
      `drop function if exists public.distribution_conflict_release_guard()`,
    );
    this.addSql(
      `drop function if exists public.distribution_conflict_row_tenant(text, uuid)`,
    );
    this.addSql(`
      alter table "distribution_consistency_conflict"
        drop column if exists "resolved_by",
        drop column if exists "resolved_at"
    `);
    this.addSql(
      `alter table "distribution_consistency_conflict" disable row level security`,
    );
    this.addSql(
      `grant select on "distribution_consistency_conflict" to "hotel_worker"`,
    );
    this.addSql(
      `grant select on "distribution_consistency_conflict" to "hotel_test"`,
    );

    this.addSql(`drop policy "tenant_isolation" on "distribution_connection"`);
    this.addSql(`
      create policy "tenant_isolation" on "distribution_connection"
        using ("tenant_id" = ${ctx})
        with check ("tenant_id" = ${ctx})
    `);

    for (const table of [
      'distribution_channel_capability',
      'distribution_mapping_version',
      'distribution_external_booking',
      'distribution_sync_checkpoint',
      'distribution_inbox_revision',
      'distribution_dedup_key',
    ]) {
      this.addSql(`drop policy "tenant_isolation" on "${table}"`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (
            exists (
              select 1 from "${table === 'distribution_dedup_key' ? 'distribution_inbox_revision' : 'distribution_connection'}" p
               where p."id" = "${table === 'distribution_dedup_key' ? 'inbox_revision_id' : 'connection_id'}"
                 and ${
                   table === 'distribution_dedup_key'
                     ? `exists (select 1 from "distribution_connection" c where c."id" = p."connection_id" and c."tenant_id" = ${ctx})`
                     : `p."tenant_id" = ${ctx}`
                 }
            )
          )
          with check (
            exists (
              select 1 from "${table === 'distribution_dedup_key' ? 'distribution_inbox_revision' : 'distribution_connection'}" p
               where p."id" = "${table === 'distribution_dedup_key' ? 'inbox_revision_id' : 'connection_id'}"
                 and ${
                   table === 'distribution_dedup_key'
                     ? `exists (select 1 from "distribution_connection" c where c."id" = p."connection_id" and c."tenant_id" = ${ctx})`
                     : `p."tenant_id" = ${ctx}`
                 }
            )
          )
      `);
    }

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_outbox_event"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_outbox_event"
        using (
          "tenant_id" = ${ctx}
          and not exists (
            select 1 from "distribution_consistency_conflict" c
             where c."table_name" = 'distribution_outbox_event'
               and c."row_id" = "distribution_outbox_event"."id"
               and c."resolution" = 'QUARANTINED_NOT_VALID'
          )
        )
        with check ("tenant_id" = ${ctx})
    `);

    for (const table of [
      'distribution_exception_case',
      'distribution_dead_letter',
    ]) {
      this.addSql(`drop policy "tenant_isolation" on "${table}"`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (
            "tenant_id" = ${ctx}
            and not exists (
              select 1 from "distribution_consistency_conflict" c
               where c."table_name" = '${table}'
                 and c."row_id" = "${table}"."id"
                 and c."resolution" = 'QUARANTINED_NOT_VALID'
            )
          )
          with check ("tenant_id" = ${ctx})
      `);
    }

    this.addSql(
      `drop policy "tenant_isolation" on "distribution_sync_attempt"`,
    );
    this.addSql(`
      create policy "tenant_isolation" on "distribution_sync_attempt"
        using (
          exists (
            select 1 from "distribution_outbox_event" o
             where o."id" = "distribution_sync_attempt"."outbox_id"
               and o."tenant_id" = ${ctx}
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
               and o."tenant_id" = ${ctx}
          )
        )
    `);

    this.addSql(`
      create or replace function public.distribution_work_tenants(p_max_attempts integer default 4)
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

    this.addSql(
      `drop function if exists public.distribution_quarantined(text, uuid)`,
    );
    this.addSql(
      `drop function if exists public.distribution_row_quarantined(text, uuid)`,
    );
  }
}
