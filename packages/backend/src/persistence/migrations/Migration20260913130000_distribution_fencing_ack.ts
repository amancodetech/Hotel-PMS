import { Migration } from '@mikro-orm/migrations';

export class Migration20260913130000_distribution_fencing_ack extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "distribution_outbox_event" add column "lease_token" uuid`,
    );
    this.addSql(`
      alter table "distribution_inbox_revision"
        add column "ack_lease_owner" varchar(200),
        add column "ack_lease_token" uuid,
        add column "ack_lease_expires_at" timestamptz,
        add column "ack_next_attempt_at" timestamptz
    `);
    this.addSql(
      `create index "distribution_inbox_ack_due_idx" on "distribution_inbox_revision" ("ack_state", "ack_next_attempt_at", "ack_lease_expires_at")`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "distribution_inbox_ack_due_idx"`);
    this.addSql(`
      alter table "distribution_inbox_revision"
        drop column if exists "ack_next_attempt_at",
        drop column if exists "ack_lease_expires_at",
        drop column if exists "ack_lease_token",
        drop column if exists "ack_lease_owner"
    `);
    this.addSql(
      `alter table "distribution_outbox_event" drop column if exists "lease_token"`,
    );
  }
}
