import { Migration } from '@mikro-orm/migrations';

export class Migration20260913150000_identity_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "app_user" (
        "id" uuid primary key default gen_random_uuid(),
        "identity_subject" varchar(255) not null,
        "issuer" varchar(255) not null,
        "email" varchar(320),
        "display_name" varchar(200),
        "status" varchar(16) not null default 'ACTIVE',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "app_user_status_check" check ("status" in ('ACTIVE', 'DISABLED')),
        constraint "app_user_subject_unique" unique ("issuer", "identity_subject")
      )
    `);

    this.addSql(`
      create table "auth_flow" (
        "id" uuid primary key default gen_random_uuid(),
        "state" char(64) not null,
        "nonce" char(64) not null,
        "code_verifier" text not null,
        "redirect_after" varchar(500),
        "expires_at" timestamptz not null,
        "used_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "auth_flow_state_unique" unique ("state")
      )
    `);

    this.addSql(`
      create table "auth_session" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "app_user" ("id") on delete cascade,
        "active_tenant_id" uuid,
        "csrf_token_hash" char(64) not null,
        "id_token" text,
        "auth_methods" jsonb not null default '[]',
        "auth_time" timestamptz,
        "expires_at" timestamptz not null,
        "revoked_at" timestamptz,
        "rotated_from" uuid,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now()
      )
    `);
    this.addSql(
      `create index "auth_session_user_idx" on "auth_session" ("user_id", "expires_at")`,
    );

    this.addSql(`
      create table "tenant" (
        "id" uuid primary key default gen_random_uuid(),
        "name" varchar(200) not null,
        "slug" varchar(64) not null,
        "status" varchar(16) not null default 'ACTIVE',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "tenant_status_check" check ("status" in ('ACTIVE', 'SUSPENDED')),
        constraint "tenant_slug_unique" unique ("slug")
      )
    `);

    this.addSql(`
      create table "membership" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "user_id" uuid not null references "app_user" ("id") on delete cascade,
        "status" varchar(16) not null default 'INVITED',
        "authz_version" integer not null default 1,
        "joined_at" timestamptz,
        "revoked_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "membership_status_check"
          check ("status" in ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
        constraint "membership_tenant_user_unique" unique ("tenant_id", "user_id"),
        constraint "membership_tenant_id_unique" unique ("id", "tenant_id")
      )
    `);
    this.addSql(
      `create index "membership_tenant_status_idx" on "membership" ("tenant_id", "status")`,
    );

    this.addSql(`
      create table "permission" (
        "code" varchar(100) primary key,
        "description_key" varchar(200) not null
      )
    `);

    this.addSql(`
      create table "role" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "code" varchar(64) not null,
        "name" varchar(200) not null,
        "description" varchar(500),
        "is_system" boolean not null default false,
        "status" varchar(16) not null default 'ACTIVE',
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "role_status_check" check ("status" in ('ACTIVE', 'RETIRED')),
        constraint "role_tenant_code_unique" unique ("tenant_id", "code"),
        constraint "role_tenant_id_unique" unique ("id", "tenant_id")
      )
    `);

    this.addSql(`
      create table "role_permission" (
        "role_id" uuid not null references "role" ("id") on delete cascade,
        "permission_code" varchar(100) not null references "permission" ("code") on delete restrict,
        primary key ("role_id", "permission_code")
      )
    `);

    this.addSql(`
      create table "role_grant" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null,
        "membership_id" uuid not null,
        "role_id" uuid not null,
        "effect" varchar(8) not null default 'GRANT',
        "scope_type" varchar(16) not null,
        "granted_by" uuid references "app_user" ("id") on delete set null,
        "reason" varchar(500),
        "expires_at" timestamptz,
        "revoked_at" timestamptz,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "role_grant_effect_check" check ("effect" in ('GRANT', 'DENY')),
        constraint "role_grant_scope_check" check ("scope_type" in ('TENANT', 'PROPERTIES')),
        constraint "role_grant_tenant_id_unique" unique ("id", "tenant_id"),
        constraint "role_grant_membership_fk"
          foreign key ("membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete cascade,
        constraint "role_grant_role_fk"
          foreign key ("role_id", "tenant_id")
          references "role" ("id", "tenant_id") on delete cascade
      )
    `);
    this.addSql(
      `create index "role_grant_membership_idx" on "role_grant" ("tenant_id", "membership_id", "revoked_at")`,
    );

    this.addSql(`
      create table "grant_property" (
        "grant_id" uuid not null,
        "tenant_id" uuid not null,
        "property_ref" uuid not null,
        primary key ("grant_id", "property_ref"),
        constraint "grant_property_grant_fk"
          foreign key ("grant_id", "tenant_id")
          references "role_grant" ("id", "tenant_id") on delete cascade
      )
    `);

    this.addSql(`
      create table "invitation" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "email" varchar(320) not null,
        "role_id" uuid,
        "scope_type" varchar(16) not null default 'TENANT',
        "scope_refs" jsonb not null default '[]',
        "token_hash" char(64) not null,
        "status" varchar(16) not null default 'PENDING',
        "expires_at" timestamptz not null,
        "used_at" timestamptz,
        "created_by" uuid references "app_user" ("id") on delete set null,
        "accepted_by" uuid references "app_user" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "invitation_status_check" check ("status" in ('PENDING', 'ACCEPTED', 'REVOKED')),
        constraint "invitation_scope_check" check ("scope_type" in ('TENANT', 'PROPERTIES')),
        constraint "invitation_token_unique" unique ("token_hash"),
        constraint "invitation_role_fk"
          foreign key ("role_id", "tenant_id")
          references "role" ("id", "tenant_id") on delete restrict
      )
    `);
    this.addSql(
      `create index "invitation_tenant_idx" on "invitation" ("tenant_id", "status", "expires_at")`,
    );

    this.addSql(`
      create table "approval_request" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete cascade,
        "action" varchar(100) not null,
        "resource_type" varchar(100) not null,
        "resource_id" uuid,
        "request_hash" char(64) not null,
        "resource_version" integer,
        "currency" char(3),
        "amount" numeric(20, 6),
        "status" varchar(16) not null default 'PENDING',
        "requested_by" uuid not null references "app_user" ("id") on delete restrict,
        "decided_by" uuid references "app_user" ("id") on delete set null,
        "reason" varchar(500),
        "decision_reason" varchar(500),
        "expires_at" timestamptz not null,
        "decided_at" timestamptz,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "approval_status_check"
          check ("status" in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
      )
    `);
    this.addSql(
      `create index "approval_tenant_idx" on "approval_request" ("tenant_id", "status", "created_at")`,
    );

    this.addSql(`
      create table "audit_event" (
        "id" uuid primary key default gen_random_uuid(),
        "tenant_id" uuid not null references "tenant" ("id") on delete restrict,
        "property_id" uuid,
        "actor_type" varchar(16) not null,
        "actor_id" uuid,
        "actor_label" varchar(200),
        "action" varchar(100) not null,
        "resource_type" varchar(100) not null,
        "resource_id" uuid,
        "outcome" varchar(16) not null,
        "before_safe" jsonb,
        "after_safe" jsonb,
        "reason" varchar(500),
        "correlation_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "audit_event_actor_check" check ("actor_type" in ('USER', 'SERVICE')),
        constraint "audit_event_outcome_check"
          check ("outcome" in ('SUCCESS', 'DENIED', 'FAILED'))
      )
    `);
    this.addSql(
      `create index "audit_event_tenant_idx" on "audit_event" ("tenant_id", "created_at" desc, "id" desc)`,
    );

    const catalog: Array<[string, string]> = [
      ['tenant.read', 'permissions.tenant.read'],
      ['tenant.manage', 'permissions.tenant.manage'],
      ['membership.read', 'permissions.membership.read'],
      ['membership.invite', 'permissions.membership.invite'],
      ['membership.manage', 'permissions.membership.manage'],
      ['membership.revoke', 'permissions.membership.revoke'],
      ['role.read', 'permissions.role.read'],
      ['role.manage', 'permissions.role.manage'],
      ['role.grant', 'permissions.role.grant'],
      ['audit.read', 'permissions.audit.read'],
      ['approval.read', 'permissions.approval.read'],
      ['approval.approve', 'permissions.approval.approve'],
    ];
    for (const [code, descriptionKey] of catalog)
      this.addSql(
        `insert into "permission" ("code", "description_key") values ('${code}', '${descriptionKey}')`,
      );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "audit_event"`);
    this.addSql(`drop table if exists "approval_request"`);
    this.addSql(`drop table if exists "invitation"`);
    this.addSql(`drop table if exists "grant_property"`);
    this.addSql(`drop table if exists "role_grant"`);
    this.addSql(`drop table if exists "role_permission"`);
    this.addSql(`drop table if exists "role"`);
    this.addSql(`drop table if exists "permission"`);
    this.addSql(`drop table if exists "membership"`);
    this.addSql(`drop table if exists "tenant"`);
    this.addSql(`drop table if exists "auth_session"`);
    this.addSql(`drop table if exists "auth_flow"`);
    this.addSql(`drop table if exists "app_user"`);
  }
}
