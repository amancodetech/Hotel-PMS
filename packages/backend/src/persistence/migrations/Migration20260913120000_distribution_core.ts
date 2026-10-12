import { Migration } from '@mikro-orm/migrations';

export class Migration20260913120000_distribution_core extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "distribution_connection" (
        "id" uuid primary key,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "provider_key" varchar(64) not null,
        "environment" varchar(32) not null,
        "channel_key" varchar(64) not null,
        "external_property_id" varchar(200),
        "secret_ref" varchar(200) not null,
        "status" varchar(32) not null default 'DRAFT',
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_connection_status_check"
          check ("status" in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
        constraint "distribution_connection_binding_unique"
          unique ("provider_key", "environment", "channel_key", "external_property_id")
      )
    `);

    this.addSql(`
      create table "distribution_channel_capability" (
        "id" uuid primary key,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "channel_key" varchar(64) not null,
        "capability_code" varchar(64) not null,
        "status" varchar(16) not null,
        "authorization_status" varchar(16) not null,
        "adapter_version" varchar(64) not null,
        "evidence_ref" varchar(300),
        "checked_at" timestamptz,
        "test_run_id" varchar(200),
        "limitations" jsonb not null default '[]',
        "owner" varchar(200),
        "recheck_trigger" varchar(300),
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_capability_status_check"
          check ("status" in ('DOCUMENTED', 'TESTED', 'UNSUPPORTED', 'UNKNOWN')),
        constraint "distribution_capability_authorization_check"
          check ("authorization_status" in ('AUTHORIZED', 'NOT_AUTHORIZED', 'UNKNOWN')),
        constraint "distribution_capability_unique"
          unique ("connection_id", "channel_key", "capability_code", "adapter_version")
      )
    `);

    this.addSql(`
      create table "distribution_mapping_version" (
        "id" uuid primary key,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "channel_key" varchar(64) not null,
        "external_room_ref" varchar(200) not null,
        "external_rate_ref" varchar(200) not null,
        "occupancy" integer not null,
        "meal_plan_ref" varchar(200),
        "internal_product_ref" uuid,
        "internal_rate_ref" uuid,
        "effective_at" timestamptz not null,
        "status" varchar(16) not null default 'DRAFT',
        "mapping_version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_mapping_occupancy_check" check ("occupancy" >= 1),
        constraint "distribution_mapping_status_check"
          check ("status" in ('DRAFT', 'ACTIVE', 'RETIRED')),
        constraint "distribution_mapping_unique"
          unique ("connection_id", "channel_key", "external_room_ref", "external_rate_ref", "occupancy", "effective_at")
      )
    `);

    this.addSql(`
      create table "distribution_external_booking" (
        "id" uuid primary key,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "channel_key" varchar(64) not null,
        "external_booking_id" varchar(200) not null,
        "provider_booking_id" varchar(200),
        "state" varchar(16) not null default 'ACTIVE',
        "latest_revision_id" varchar(200),
        "latest_payload_hash" char(64),
        "source_sequence" varchar(30),
        "source_time" timestamptz,
        "reservation_ref" uuid,
        "exception_id" uuid,
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_external_booking_state_check"
          check ("state" in ('ACTIVE', 'CANCELLED', 'EXCEPTION')),
        constraint "distribution_external_booking_unique"
          unique ("connection_id", "external_booking_id")
      )
    `);

    this.addSql(`
      create table "distribution_exception_case" (
        "id" uuid primary key,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid references "distribution_connection" ("id") on delete set null,
        "inbox_revision_id" uuid,
        "outbox_id" uuid,
        "type" varchar(64) not null,
        "state" varchar(24) not null default 'OPEN',
        "owner" varchar(200),
        "resolution" varchar(1000),
        "details_safe" jsonb not null default '{}',
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_exception_state_check"
          check ("state" in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'))
      )
    `);

    this.addSql(`
      create table "distribution_inbox_revision" (
        "id" uuid primary key,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "channel_key" varchar(64) not null,
        "provider_key" varchar(64) not null,
        "environment" varchar(32) not null,
        "provider_revision_id" varchar(200) not null,
        "external_booking_id" varchar(200) not null,
        "revision_type" varchar(16) not null,
        "payload_hash" char(64) not null,
        "payload_safe" jsonb not null,
        "source_sequence" varchar(30),
        "source_time" timestamptz,
        "received_at" timestamptz not null,
        "processing_state" varchar(24) not null default 'RECEIVED',
        "safe_error_code" varchar(32),
        "external_booking_ref" uuid references "distribution_external_booking" ("id") on delete set null,
        "exception_id" uuid references "distribution_exception_case" ("id") on delete set null,
        "ack_state" varchar(16) not null default 'PENDING',
        "ack_attempt_count" integer not null default 0,
        "ack_provider_request_id" varchar(200),
        "applied_at" timestamptz,
        "last_attempt_at" timestamptz,
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_inbox_type_check"
          check ("revision_type" in ('new', 'modified', 'cancelled')),
        constraint "distribution_inbox_processing_check"
          check ("processing_state" in ('RECEIVED', 'APPLIED', 'DUPLICATE', 'IGNORED_STALE', 'EXCEPTION', 'UNKNOWN')),
        constraint "distribution_inbox_ack_check"
          check ("ack_state" in ('PENDING', 'SENT', 'UNKNOWN', 'FAILED', 'NOT_REQUIRED')),
        constraint "distribution_inbox_revision_unique"
          unique ("connection_id", "provider_revision_id")
      )
    `);

    this.addSql(`
      create table "distribution_dedup_key" (
        "id" uuid primary key,
        "scope" varchar(200) not null,
        "dedup_key" varchar(300) not null,
        "payload_hash" char(64),
        "inbox_revision_id" uuid references "distribution_inbox_revision" ("id") on delete set null,
        "created_at" timestamptz not null default now(),
        constraint "distribution_dedup_unique" unique ("scope", "dedup_key")
      )
    `);

    this.addSql(`
      create table "distribution_outbox_event" (
        "id" uuid primary key,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "channel_key" varchar(64) not null,
        "aggregate_type" varchar(64) not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(64) not null,
        "event_version" integer not null,
        "inventory_version" integer not null,
        "payload_safe" jsonb not null,
        "status" varchar(24) not null default 'PENDING',
        "attempt_count" integer not null default 0,
        "lease_owner" varchar(200),
        "lease_expires_at" timestamptz,
        "next_attempt_at" timestamptz not null default now(),
        "last_safe_error_code" varchar(32),
        "provider_request_id" varchar(200),
        "provider_task_id" varchar(200),
        "certainty" varchar(24),
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "distribution_outbox_status_check"
          check ("status" in ('PENDING', 'LEASED', 'SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED', 'PARTIAL', 'UNKNOWN', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'CANCELLED', 'SUPERSEDED')),
        constraint "distribution_outbox_event_unique"
          unique ("connection_id", "aggregate_type", "aggregate_id", "event_type", "event_version")
      )
    `);

    this.addSql(`
      create table "distribution_sync_attempt" (
        "id" uuid primary key,
        "outbox_id" uuid not null references "distribution_outbox_event" ("id") on delete cascade,
        "attempt_no" integer not null,
        "status" varchar(16) not null,
        "certainty" varchar(24),
        "http_status" integer,
        "provider_request_id" varchar(200),
        "provider_task_id" varchar(200),
        "safe_error_code" varchar(32),
        "retry_after_ms" integer,
        "started_at" timestamptz not null,
        "finished_at" timestamptz,
        "response_safe" jsonb,
        "created_at" timestamptz not null default now(),
        constraint "distribution_attempt_status_check"
          check ("status" in ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REJECTED')),
        constraint "distribution_attempt_unique" unique ("outbox_id", "attempt_no")
      )
    `);

    this.addSql(`
      create table "distribution_sync_checkpoint" (
        "id" uuid primary key,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "stream" varchar(64) not null,
        "cursor" text,
        "last_pull_at" timestamptz,
        "version" integer not null default 0,
        "updated_at" timestamptz not null default now(),
        constraint "distribution_checkpoint_unique" unique ("connection_id", "stream")
      )
    `);

    this.addSql(`
      create table "distribution_dead_letter" (
        "id" uuid primary key,
        "tenant_id" uuid not null,
        "property_id" uuid not null,
        "connection_id" uuid not null references "distribution_connection" ("id") on delete cascade,
        "outbox_id" uuid references "distribution_outbox_event" ("id") on delete set null,
        "event_type" varchar(64) not null,
        "payload_safe" jsonb not null,
        "safe_error_code" varchar(32),
        "attempts" integer not null,
        "reason" varchar(300) not null,
        "reprocessed_at" timestamptz,
        "reprocessed_by" varchar(200),
        "reprocess_reason" varchar(300),
        "created_at" timestamptz not null default now()
      )
    `);

    this.addSql(`
      alter table "distribution_exception_case"
        add constraint "distribution_exception_inbox_fk"
        foreign key ("inbox_revision_id") references "distribution_inbox_revision" ("id") on delete set null
    `);
    this.addSql(`
      alter table "distribution_exception_case"
        add constraint "distribution_exception_outbox_fk"
        foreign key ("outbox_id") references "distribution_outbox_event" ("id") on delete set null
    `);

    this.addSql(
      `create index "distribution_inbox_pending_idx" on "distribution_inbox_revision" ("connection_id", "processing_state", "created_at")`,
    );
    this.addSql(
      `create index "distribution_inbox_ack_idx" on "distribution_inbox_revision" ("ack_state", "created_at")`,
    );
    this.addSql(
      `create index "distribution_outbox_due_idx" on "distribution_outbox_event" ("status", "next_attempt_at")`,
    );
    this.addSql(
      `create index "distribution_exception_open_idx" on "distribution_exception_case" ("state", "created_at")`,
    );
    this.addSql(
      `create index "distribution_mapping_lookup_idx" on "distribution_mapping_version" ("connection_id", "status", "external_room_ref", "external_rate_ref")`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "distribution_dead_letter"`);
    this.addSql(`drop table if exists "distribution_sync_checkpoint"`);
    this.addSql(`drop table if exists "distribution_sync_attempt"`);
    this.addSql(`drop table if exists "distribution_outbox_event"`);
    this.addSql(`drop table if exists "distribution_dedup_key"`);
    this.addSql(`drop table if exists "distribution_inbox_revision"`);
    this.addSql(`drop table if exists "distribution_exception_case"`);
    this.addSql(`drop table if exists "distribution_external_booking"`);
    this.addSql(`drop table if exists "distribution_mapping_version"`);
    this.addSql(`drop table if exists "distribution_channel_capability"`);
    this.addSql(`drop table if exists "distribution_connection"`);
  }
}
