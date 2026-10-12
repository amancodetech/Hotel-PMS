import { Migration } from '@mikro-orm/migrations';

/**
 * P12-04 fix (F-RVW12-01): platform onboarding must honor the documented
 * idempotency rule (docs/26: the same key with different content is a 409
 * IDEMPOTENCY_CONFLICT). Lifecycle events scope their key per tenant, so a new
 * tenant with the same key could be created; this platform-wide request record
 * stores the key, a SHA-256 fingerprint of the normalized request and the
 * stored response. The onboarding transaction inserts it atomically with the
 * tenant, so a concurrent retry either replays the stored response or fails
 * closed without creating a second tenant.
 */
export class Migration20260917090000_platform_onboarding_idempotency extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "platform_onboarding_request" (
        "id" uuid primary key default gen_random_uuid(),
        "idempotency_key" varchar(200) not null,
        "fingerprint" varchar(64) not null,
        "tenant_id" uuid not null references "tenant" ("id") on delete restrict,
        "response" jsonb not null,
        "actor_user_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "platform_onboarding_request_key_unique"
          unique ("idempotency_key"),
        constraint "platform_onboarding_request_fingerprint_check" check (
          "fingerprint" ~ '^[0-9a-f]{64}$'
        )
      )
    `);
    this.addSql(`
      create index "platform_onboarding_request_tenant_idx"
        on "platform_onboarding_request" ("tenant_id")
    `);
    this.addSql(
      `alter table "platform_onboarding_request" enable row level security`,
    );
    this.addSql(
      `alter table "platform_onboarding_request" force row level security`,
    );
    this.addSql(`
      create policy "platform_access" on "platform_onboarding_request"
        using (public.is_active_platform_staff(
          nullif(current_setting('app.platform_user_id', true), '')::uuid
        ))
        with check (public.is_active_platform_staff(
          nullif(current_setting('app.platform_user_id', true), '')::uuid
        ))
    `);
    this.addSql(
      `grant select, insert on "platform_onboarding_request" to "hotel_api"`,
    );
    this.addSql(
      `grant select, insert, update, delete on "platform_onboarding_request" to "hotel_test"`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "platform_onboarding_request" cascade`);
  }
}
