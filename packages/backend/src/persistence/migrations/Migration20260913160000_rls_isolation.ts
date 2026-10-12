import { Migration } from '@mikro-orm/migrations';

const runtimeRoles = ['hotel_api', 'hotel_worker', 'hotel_test'] as const;
const directTenantTables = [
  'role',
  'role_grant',
  'grant_property',
  'approval_request',
  'audit_event',
  'distribution_connection',
  'distribution_exception_case',
  'distribution_outbox_event',
  'distribution_dead_letter',
] as const;

const indirectTenantTables: Array<[string, string]> = [
  [
    'distribution_channel_capability',
    `exists (select 1 from "distribution_connection" p where p."id" = "connection_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_mapping_version',
    `exists (select 1 from "distribution_connection" p where p."id" = "connection_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_external_booking',
    `exists (select 1 from "distribution_connection" p where p."id" = "connection_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_inbox_revision',
    `exists (select 1 from "distribution_connection" p where p."id" = "connection_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_sync_checkpoint',
    `exists (select 1 from "distribution_connection" p where p."id" = "connection_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_sync_attempt',
    `exists (select 1 from "distribution_outbox_event" p where p."id" = "outbox_id" and p."tenant_id" = ctx)`,
  ],
  [
    'distribution_dedup_key',
    `exists (
       select 1
         from "distribution_inbox_revision" i
         join "distribution_connection" c on c."id" = i."connection_id"
        where i."id" = "inbox_revision_id" and c."tenant_id" = ctx
     )`,
  ],
];

export class Migration20260913160000_rls_isolation extends Migration {
  override async up(): Promise<void> {
    for (const role of runtimeRoles)
      this.addSql(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = '${role}') then
            create role "${role}" nologin;
          end if;
        end $$
      `);

    this.addSql(`
      create or replace function public.prevent_tenant_id_change()
      returns trigger
      language plpgsql
      as $$
      begin
        if new."tenant_id" is distinct from old."tenant_id" then
          raise exception 'tenant_id is immutable' using errcode = '42501';
        end if;
        return new;
      end
      $$
    `);

    for (const table of directTenantTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
          with check ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
      this.addSql(`
        create trigger "prevent_tenant_id_change"
        before update on "${table}"
        for each row execute function public.prevent_tenant_id_change()
      `);
    }

    this.addSql(`alter table "tenant" enable row level security`);
    this.addSql(`alter table "tenant" force row level security`);
    this.addSql(`
      create policy "tenant_isolation" on "tenant"
        using (
          "id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          or exists (
            select 1 from "membership" m
             where m."tenant_id" = "tenant"."id"
               and m."user_id" = nullif(current_setting('app.user_id', true), '')::uuid
               and m."status" = 'ACTIVE'
          )
        )
        with check (
          "id" = nullif(current_setting('app.tenant_id', true), '')::uuid
        )
    `);

    this.addSql(`alter table "membership" enable row level security`);
    this.addSql(`alter table "membership" force row level security`);
    this.addSql(`
      create policy "membership_isolation" on "membership"
        using (
          "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          or "user_id" = nullif(current_setting('app.user_id', true), '')::uuid
        )
        with check (
          "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
        )
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "membership"
      for each row execute function public.prevent_tenant_id_change()
    `);

    this.addSql(`alter table "role_permission" enable row level security`);
    this.addSql(`alter table "role_permission" force row level security`);
    this.addSql(`
      create policy "role_permission_isolation" on "role_permission"
        using (
          exists (
            select 1 from "role" r
             where r."id" = "role_permission"."role_id"
               and r."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
        with check (
          exists (
            select 1 from "role" r
             where r."id" = "role_permission"."role_id"
               and r."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          )
        )
    `);

    this.addSql(`alter table "invitation" enable row level security`);
    this.addSql(`alter table "invitation" force row level security`);
    this.addSql(`
      create policy "invitation_isolation" on "invitation"
        using (
          "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
          or "token_hash" = nullif(current_setting('app.invitation_hash', true), '')
        )
        with check (
          "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
        )
    `);
    this.addSql(`
      create trigger "prevent_tenant_id_change"
      before update on "invitation"
      for each row execute function public.prevent_tenant_id_change()
    `);

    for (const [table, predicate] of indirectTenantTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      const policy = predicate.replaceAll(
        'ctx',
        `nullif(current_setting('app.tenant_id', true), '')::uuid`,
      );
      this.addSql(`
        create policy "tenant_isolation" on "${table}"
          using (${policy})
          with check (${policy})
      `);
    }

    this.addSql(
      `create index "distribution_connection_tenant_idx" on "distribution_connection" ("tenant_id")`,
    );
    this.addSql(
      `create index "distribution_exception_tenant_idx" on "distribution_exception_case" ("tenant_id", "state")`,
    );
    this.addSql(
      `create index "distribution_outbox_tenant_idx" on "distribution_outbox_event" ("tenant_id", "status", "next_attempt_at")`,
    );
    this.addSql(
      `create index "distribution_dead_letter_tenant_idx" on "distribution_dead_letter" ("tenant_id", "created_at")`,
    );

    this.addSql(`
      create or replace function public.distribution_work_tenants()
      returns table (tenant_id uuid)
      language sql
      security definer
      set search_path = public
      as $$
        select distinct c.tenant_id
          from distribution_inbox_revision i
          join distribution_connection c on c.id = i.connection_id
         where i.ack_state in ('PENDING', 'FAILED')
           and i.ack_next_attempt_at is not null
           and i.ack_next_attempt_at <= now()
        union
        select distinct o.tenant_id
          from distribution_outbox_event o
         where o.status in ('PENDING', 'LEASED', 'RETRY_SCHEDULED', 'UNKNOWN', 'PARTIAL')
           and o.next_attempt_at <= now()
         limit 200
      $$
    `);

    this.addSql(`revoke all on all tables in schema public from public`);
    this.addSql(
      `grant usage on schema public to ${runtimeRoles.map((role) => `"${role}"`).join(', ')}`,
    );

    this.addSql(`
      grant select, insert, update, delete on
        "app_user", "auth_session", "auth_flow", "membership", "role",
        "role_permission", "role_grant", "grant_property", "invitation",
        "approval_request"
      to "hotel_api"
    `);
    this.addSql(`grant select on "tenant" to "hotel_api"`);
    this.addSql(`grant select, insert on "audit_event" to "hotel_api"`);
    this.addSql(`grant select on "permission" to "hotel_api"`);

    this.addSql(`
      grant select, insert, update, delete on
        "distribution_connection", "distribution_channel_capability",
        "distribution_mapping_version", "distribution_external_booking",
        "distribution_exception_case", "distribution_inbox_revision",
        "distribution_dedup_key", "distribution_outbox_event",
        "distribution_sync_attempt", "distribution_sync_checkpoint",
        "distribution_dead_letter"
      to "hotel_worker"
    `);
    this.addSql(`grant select on "permission" to "hotel_worker"`);
    this.addSql(
      `grant execute on function public.distribution_work_tenants() to "hotel_worker"`,
    );

    this.addSql(`
      grant select, insert, update, delete on
        "app_user", "auth_session", "auth_flow", "membership", "role",
        "role_permission", "role_grant", "grant_property", "invitation",
        "approval_request", "distribution_connection",
        "distribution_channel_capability", "distribution_mapping_version",
        "distribution_external_booking", "distribution_exception_case",
        "distribution_inbox_revision", "distribution_dedup_key",
        "distribution_outbox_event", "distribution_sync_attempt",
        "distribution_sync_checkpoint", "distribution_dead_letter"
      to "hotel_test"
    `);
    this.addSql(`grant select on "tenant" to "hotel_test"`);
    this.addSql(`grant select, insert on "audit_event" to "hotel_test"`);
    this.addSql(`grant select on "permission" to "hotel_test"`);
    this.addSql(
      `grant execute on function public.distribution_work_tenants() to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    for (const table of [...directTenantTables, 'membership', 'invitation'])
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
    for (const [table] of indirectTenantTables)
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    for (const table of directTenantTables)
      this.addSql(`drop policy if exists "tenant_isolation" on "${table}"`);
    this.addSql(`drop policy if exists "membership_isolation" on "membership"`);
    this.addSql(
      `drop policy if exists "role_permission_isolation" on "role_permission"`,
    );
    this.addSql(`drop policy if exists "invitation_isolation" on "invitation"`);
    this.addSql(`drop function if exists public.distribution_work_tenants()`);
    this.addSql(`drop function if exists public.prevent_tenant_id_change()`);
    for (const role of runtimeRoles)
      this.addSql(`drop role if exists "${role}"`);
  }
}
