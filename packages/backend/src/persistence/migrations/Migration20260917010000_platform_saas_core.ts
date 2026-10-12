import { Migration } from '@mikro-orm/migrations';

/**
 * P12-01 platform SaaS core: plans, dated policy versions, subscriptions,
 * entitlements, idempotent usage metering with atomic declarative limits,
 * documented administrative billing, platform staff identities, platform
 * audit and platform support grants. Platform billing is administrative and
 * separate from the hotel ledger: nothing here writes journal, journal_line,
 * business_day or folio_charge. Tenant stays the isolation boundary; platform
 * permissions never grant guest data access, and platform tenant reads go
 * through an explicit, time-boxed, audited support grant (SEC-006).
 */
export class Migration20260917010000_platform_saas_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "tenant" drop constraint if exists "tenant_status_check"`,
    );
    this.addSql(`
      alter table "tenant" add constraint "tenant_status_check"
        check ("status" in ('ACTIVE', 'SUSPENDED', 'CLOSED'))
    `);

    this.addSql(`
      create table "platform_staff" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "app_user" ("id") on delete restrict,
        "role_code" varchar(32) not null,
        "status" varchar(16) not null default 'ACTIVE',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_staff_user_unique" unique ("user_id"),
        constraint "platform_staff_role_check" check (
          "role_code" in ('PLATFORM_ADMIN', 'PLATFORM_SUPPORT')
        ),
        constraint "platform_staff_status_check" check (
          "status" in ('ACTIVE', 'REVOKED')
        )
      )
    `);

    this.addSql(`
      create or replace function public.is_active_platform_staff(p_user uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $$
        select exists (
          select 1 from "platform_staff" s
           where s."user_id" = p_user and s."status" = 'ACTIVE'
        )
      $$
    `);

    this.addSql(`
      create table "platform_plan" (
        "id" uuid primary key default gen_random_uuid(),
        "code" varchar(64) not null,
        "name" varchar(200) not null,
        "status" varchar(16) not null default 'ACTIVE',
        "created_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_plan_code_unique" unique ("code"),
        constraint "platform_plan_status_check" check (
          "status" in ('ACTIVE', 'RETIRED')
        )
      )
    `);

    this.addSql(`
      create table "platform_plan_policy_version" (
        "id" uuid primary key default gen_random_uuid(),
        "plan_id" uuid not null references "platform_plan" ("id") on delete restrict,
        "version" integer not null,
        "effective_from" date not null,
        "limits" jsonb not null default '{}'::jsonb,
        "entitlements" jsonb not null default '{}'::jsonb,
        "notes" varchar(500),
        "created_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        constraint "platform_policy_version_unique" unique ("plan_id", "version"),
        constraint "platform_policy_effective_unique" unique ("plan_id", "effective_from"),
        constraint "platform_policy_version_positive" check ("version" > 0),
        constraint "platform_policy_no_backdate" check (
          "effective_from" >= ("created_at" at time zone 'UTC')::date
        ),
        constraint "platform_policy_limits_object" check (
          jsonb_typeof("limits") = 'object'
        ),
        constraint "platform_policy_entitlements_object" check (
          jsonb_typeof("entitlements") = 'object'
        )
      )
    `);

    this.addSql(`
      create table "platform_subscription" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete restrict,
        "customer_label" varchar(200) not null,
        "plan_id" uuid not null references "platform_plan" ("id") on delete restrict,
        "policy_version_id" uuid not null
          references "platform_plan_policy_version" ("id") on delete restrict,
        "plan_code" varchar(64) not null,
        "policy_version" integer not null,
        "policy_snapshot" jsonb not null,
        "state" varchar(16) not null default 'PENDING',
        "version" integer not null default 1,
        "started_at" timestamptz,
        "suspended_at" timestamptz,
        "suspension_reason" varchar(500),
        "reactivated_at" timestamptz,
        "closed_at" timestamptz,
        "close_reason" varchar(500),
        "created_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_subscription_tenant_unique" unique ("tenant_id"),
        constraint "platform_subscription_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_subscription_state_check" check (
          "state" in ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED')
        ),
        constraint "platform_subscription_version_positive" check ("version" > 0)
      )
    `);

    this.addSql(`
      create table "platform_entitlement" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "subscription_id" uuid not null,
        "capability_code" varchar(64) not null,
        "state" varchar(16) not null,
        "limits" jsonb not null default '{}'::jsonb,
        "source" varchar(16) not null default 'PLAN',
        "version" integer not null default 1,
        "expires_at" timestamptz,
        "created_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_entitlement_tenant_unique" unique ("tenant_id", "capability_code"),
        constraint "platform_entitlement_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_entitlement_state_check" check (
          "state" in ('ENABLED', 'DISABLED')
        ),
        constraint "platform_entitlement_source_check" check (
          "source" in ('PLAN', 'OVERRIDE')
        ),
        constraint "platform_entitlement_version_positive" check ("version" > 0),
        constraint "platform_entitlement_limits_object" check (
          jsonb_typeof("limits") = 'object'
        ),
        constraint "platform_entitlement_subscription_fk"
          foreign key ("subscription_id", "tenant_id")
          references "platform_subscription" ("id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "platform_entitlement_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "entitlement_id" uuid not null,
        "capability_code" varchar(64) not null,
        "state" varchar(16) not null,
        "limits" jsonb not null default '{}'::jsonb,
        "source" varchar(16) not null,
        "effective_from" date not null,
        "reason" varchar(500),
        "actor_user_id" uuid,
        "actor_label" text,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        constraint "platform_entitlement_event_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_entitlement_event_state_check" check (
          "state" in ('ENABLED', 'DISABLED')
        ),
        constraint "platform_entitlement_event_source_check" check (
          "source" in ('PLAN', 'OVERRIDE')
        ),
        constraint "platform_entitlement_event_no_backdate" check (
          "effective_from" >= ("created_at" at time zone 'UTC')::date
        ),
        constraint "platform_entitlement_event_fk"
          foreign key ("entitlement_id", "tenant_id")
          references "platform_entitlement" ("id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "platform_usage_counter" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "metric" varchar(64) not null,
        "period_key" varchar(16) not null default 'TOTAL',
        "used" bigint not null default 0,
        "limit_value" bigint not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_usage_counter_unique"
          unique ("tenant_id", "metric", "period_key"),
        constraint "platform_usage_counter_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_usage_counter_used_check" check ("used" >= 0),
        constraint "platform_usage_counter_limit_check" check ("limit_value" >= 0)
      )
    `);

    this.addSql(`
      create table "platform_usage_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "metric" varchar(64) not null,
        "quantity" bigint not null,
        "idempotency_key" varchar(200) not null,
        "correlation_id" text,
        "recorded_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        constraint "platform_usage_event_unique"
          unique ("tenant_id", "metric", "idempotency_key"),
        constraint "platform_usage_event_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_usage_event_quantity_check" check ("quantity" > 0)
      )
    `);

    this.addSql(`create sequence "platform_invoice_number_seq"`);

    this.addSql(`
      create table "platform_invoice" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "number" varchar(40) not null,
        "period_start" date not null,
        "period_end" date not null,
        "currency" varchar(3) not null,
        "total_amount" numeric(20, 6) not null default 0,
        "state" varchar(16) not null default 'ISSUED',
        "issued_by" uuid references "app_user" ("id") on delete set null,
        "issued_at" timestamptz not null default now(),
        "voided_at" timestamptz,
        "voided_by" uuid references "app_user" ("id") on delete set null,
        "void_reason" varchar(500),
        "settled_at" timestamptz,
        "settled_by" uuid references "app_user" ("id") on delete set null,
        "settlement_reference" varchar(200),
        "notes" varchar(500),
        "idempotency_key" varchar(200) not null,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_invoice_number_unique" unique ("tenant_id", "number"),
        constraint "platform_invoice_idempotency_unique"
          unique ("tenant_id", "idempotency_key"),
        constraint "platform_invoice_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_invoice_currency_check" check ("currency" in ('IDR', 'USD')),
        constraint "platform_invoice_state_check" check (
          "state" in ('ISSUED', 'VOID', 'SETTLED')
        ),
        constraint "platform_invoice_period_check" check ("period_end" > "period_start"),
        constraint "platform_invoice_total_check" check ("total_amount" >= 0),
        constraint "platform_invoice_void_check" check (
          ("state" <> 'VOID') or ("voided_at" is not null and "void_reason" is not null)
        ),
        constraint "platform_invoice_settlement_check" check (
          ("state" <> 'SETTLED') or
          ("settled_at" is not null and "settlement_reference" is not null)
        )
      )
    `);

    this.addSql(`
      create table "platform_invoice_line" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "invoice_id" uuid not null,
        "description" varchar(300) not null,
        "quantity" numeric(20, 6) not null,
        "unit_amount" numeric(20, 6) not null,
        "amount" numeric(20, 6) not null,
        "created_at" timestamptz not null default now(),
        constraint "platform_invoice_line_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_invoice_line_quantity_check" check ("quantity" > 0),
        constraint "platform_invoice_line_unit_check" check ("unit_amount" >= 0),
        constraint "platform_invoice_line_amount_check" check ("amount" >= 0),
        constraint "platform_invoice_line_invoice_fk"
          foreign key ("invoice_id", "tenant_id")
          references "platform_invoice" ("id", "tenant_id") on delete restrict
      )
    `);

    this.addSql(`
      create table "platform_audit_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid references "tenant" ("id") on delete restrict,
        "actor_user_id" uuid,
        "actor_role" varchar(32),
        "action" varchar(100) not null,
        "resource_type" varchar(100) not null,
        "resource_id" uuid,
        "outcome" varchar(16) not null,
        "before_safe" jsonb,
        "after_safe" jsonb,
        "reason" varchar(500),
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        constraint "platform_audit_outcome_check" check (
          "outcome" in ('SUCCESS', 'DENIED', 'FAILED')
        )
      )
    `);

    this.addSql(`
      create table "platform_support_grant" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete restrict,
        "platform_user_id" uuid not null references "app_user" ("id") on delete restrict,
        "scopes" jsonb not null,
        "reason" varchar(500) not null,
        "granted_by_user_id" uuid not null references "app_user" ("id") on delete restrict,
        "starts_at" timestamptz not null default now(),
        "expires_at" timestamptz not null,
        "revoked_at" timestamptz,
        "revoked_by_user_id" uuid references "app_user" ("id") on delete set null,
        "revoke_reason" varchar(500),
        "idempotency_key" varchar(200) not null,
        "correlation_id" text,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "platform_support_grant_scope_unique" unique ("id", "tenant_id"),
        constraint "platform_support_grant_idempotency_unique"
          unique ("tenant_id", "idempotency_key"),
        constraint "platform_support_grant_expiry_check" check ("expires_at" > "starts_at"),
        constraint "platform_support_grant_scopes_check" check (
          jsonb_typeof("scopes") = 'array' and
          jsonb_array_length("scopes") > 0 and
          "scopes" <@ '["tenant.read", "audit.read"]'::jsonb
        ),
        constraint "platform_support_grant_revoke_check" check (
          "revoked_at" is null or "revoked_by_user_id" is not null
        )
      )
    `);
    this.addSql(`
      create index "platform_support_grant_lookup_idx"
        on "platform_support_grant" ("tenant_id", "platform_user_id", "expires_at")
    `);

    this.addSql(`
      create or replace function public.platform_consume_usage(
        p_tenant uuid,
        p_metric text,
        p_delta bigint
      )
      returns table (outcome text, used bigint, limit_value bigint)
      language plpgsql
      security definer
      set search_path = public
      as $$
      declare
        v_context uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
        v_platform uuid := nullif(current_setting('app.platform_user_id', true), '')::uuid;
        v_used bigint;
        v_limit bigint;
      begin
        if p_delta is null or p_delta <= 0 then
          return query select 'INVALID_DELTA'::text, null::bigint, null::bigint;
          return;
        end if;
        if not (
          coalesce(v_context = p_tenant, false) or
          public.is_active_platform_staff(v_platform)
        ) then
          raise exception 'platform_usage_scope_denied' using errcode = '42501';
        end if;
        update "platform_usage_counter" c
           set "used" = c."used" + p_delta,
               "updated_at" = now()
         where c."tenant_id" = p_tenant
           and c."metric" = p_metric
           and c."used" + p_delta <= c."limit_value"
        returning c."used", c."limit_value" into v_used, v_limit;
        if found then
          return query select 'OK'::text, v_used, v_limit;
          return;
        end if;
        select c."used", c."limit_value" into v_used, v_limit
          from "platform_usage_counter" c
         where c."tenant_id" = p_tenant and c."metric" = p_metric;
        if found then
          return query select 'LIMIT_EXCEEDED'::text, v_used, v_limit;
          return;
        end if;
        return query select 'NOT_CONFIGURED'::text, null::bigint, null::bigint;
      end
      $$
    `);

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
        p_correlation text
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

    this.addSql(`
      create or replace function public.platform_policy_version_immutable()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'platform_policy_version_immutable' using errcode = '23514';
      end
      $$
    `);
    this.addSql(`
      create trigger "platform_policy_version_immutable"
      before update or delete on "platform_plan_policy_version"
      for each row execute function public.platform_policy_version_immutable()
    `);
    this.addSql(`
      create trigger "platform_entitlement_event_immutable"
      before update or delete on "platform_entitlement_event"
      for each row execute function public.platform_policy_version_immutable()
    `);

    const rlsTables = [
      'platform_staff',
      'platform_plan',
      'platform_plan_policy_version',
      'platform_subscription',
      'platform_entitlement',
      'platform_entitlement_event',
      'platform_usage_counter',
      'platform_usage_event',
      'platform_invoice',
      'platform_invoice_line',
      'platform_audit_event',
      'platform_support_grant',
    ];
    for (const table of rlsTables) {
      this.addSql(`alter table "${table}" enable row level security`);
      this.addSql(`alter table "${table}" force row level security`);
      this.addSql(`
        create policy "platform_access" on "${table}"
          using (public.is_active_platform_staff(
            nullif(current_setting('app.platform_user_id', true), '')::uuid
          ))
          with check (public.is_active_platform_staff(
            nullif(current_setting('app.platform_user_id', true), '')::uuid
          ))
      `);
    }
    const tenantReadTables = [
      'platform_subscription',
      'platform_entitlement',
      'platform_usage_counter',
      'platform_invoice',
      'platform_invoice_line',
      'platform_support_grant',
    ];
    for (const table of tenantReadTables) {
      this.addSql(`
        create policy "tenant_read" on "${table}" for select
          using ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
      `);
    }
    const tenantScopedTables = [
      'platform_subscription',
      'platform_entitlement',
      'platform_entitlement_event',
      'platform_usage_counter',
      'platform_usage_event',
      'platform_invoice',
      'platform_invoice_line',
      'platform_audit_event',
      'platform_support_grant',
    ];
    for (const table of tenantScopedTables) {
      this.addSql(`
        create trigger "prevent_tenant_id_change"
        before update on "${table}"
        for each row execute function public.prevent_tenant_id_change()
      `);
    }

    this.addSql(
      `grant execute on function public.is_active_platform_staff(uuid) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.is_active_platform_staff(uuid) to "hotel_worker"`,
    );
    this.addSql(
      `grant execute on function public.is_active_platform_staff(uuid) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_consume_usage(uuid, text, bigint) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_consume_usage(uuid, text, bigint) to "hotel_test"`,
    );
    this.addSql(
      `grant execute on function public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, text) to "hotel_api"`,
    );
    this.addSql(
      `grant execute on function public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, text) to "hotel_test"`,
    );

    this.addSql(`grant select on "platform_staff" to "hotel_api"`);
    this.addSql(
      `grant select, insert, update, delete on "platform_staff" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_plan" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_plan" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_plan_policy_version" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_plan_policy_version" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_subscription" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_subscription" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_entitlement" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_entitlement" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_entitlement_event" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_entitlement_event" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_usage_counter" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_usage_counter" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_usage_event" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_usage_event" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_invoice" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_invoice" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_invoice_line" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_invoice_line" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert on "platform_audit_event" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_audit_event" to "hotel_test"`,
    );
    this.addSql(
      `grant select, insert, update on "platform_support_grant" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_support_grant" to "hotel_test"`,
    );

    this.addSql(`
      insert into "permission" ("code", "description_key") values
        ('platform.read', 'permissions.platform.read'),
        ('subscription.read', 'permissions.subscription.read'),
        ('subscription.manage', 'permissions.subscription.manage'),
        ('platform.billing.manage', 'permissions.platform.billing.manage'),
        ('platform.support.manage', 'permissions.platform.support.manage'),
        ('platform.support.read', 'permissions.platform.support.read')
      on conflict ("code") do nothing
    `);
    this.addSql(`
      insert into "role_permission" ("role_id", "permission_code")
      select r."id", 'subscription.read'
        from "role" r
       where r."is_system" = true
         and r."code" in ('TENANT_OWNER', 'TENANT_ADMIN', 'AUDITOR')
      on conflict do nothing
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      delete from "role_permission" where "permission_code" = 'subscription.read'
    `);
    this.addSql(`
      delete from "permission" where "code" in (
        'platform.read', 'subscription.read', 'subscription.manage',
        'platform.billing.manage', 'platform.support.manage',
        'platform.support.read'
      )
    `);
    const tables = [
      'platform_support_grant',
      'platform_audit_event',
      'platform_invoice_line',
      'platform_invoice',
      'platform_usage_event',
      'platform_usage_counter',
      'platform_entitlement_event',
      'platform_entitlement',
      'platform_subscription',
      'platform_plan_policy_version',
      'platform_plan',
      'platform_staff',
    ];
    for (const table of tables) {
      this.addSql(
        `revoke all on "${table}" from "hotel_api", "hotel_worker", "hotel_test"`,
      );
    }
    this.addSql(
      `revoke execute on function public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, text) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.platform_consume_usage(uuid, text, bigint) from "hotel_api", "hotel_test"`,
    );
    this.addSql(
      `revoke execute on function public.is_active_platform_staff(uuid) from "hotel_api", "hotel_worker", "hotel_test"`,
    );
    for (const table of tables)
      this.addSql(`drop table if exists "${table}" cascade`);
    this.addSql(
      `drop function if exists public.platform_policy_version_immutable()`,
    );
    this.addSql(
      `drop function if exists public.platform_record_tenant_audit(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, text, text)`,
    );
    this.addSql(
      `drop function if exists public.platform_consume_usage(uuid, text, bigint)`,
    );
    this.addSql(`drop sequence if exists "platform_invoice_number_seq"`);
    this.addSql(
      `drop function if exists public.is_active_platform_staff(uuid)`,
    );
    this.addSql(
      `alter table "tenant" drop constraint if exists "tenant_status_check"`,
    );
    this.addSql(`
      alter table "tenant" add constraint "tenant_status_check"
        check ("status" in ('ACTIVE', 'SUSPENDED'))
    `);
  }
}
