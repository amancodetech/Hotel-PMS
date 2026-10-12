import { Migration } from '@mikro-orm/migrations';

export class Migration20260915150000_p07_hardening extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "room_assignment" drop constraint "room_assignment_no_overlap"`,
    );
    this.addSql(`
      alter table "room_assignment"
        add constraint "room_assignment_no_overlap"
        exclude using gist (
          "tenant_id" with =,
          "property_id" with =,
          "resource_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        ) where ("state" in ('PLANNED', 'ACTIVE'))
    `);
    this.addSql(`
      alter table "api_idempotency"
        drop constraint "api_idempotency_unique"
    `);
    this.addSql(`
      alter table "api_idempotency"
        add constraint "api_idempotency_unique"
        unique nulls not distinct ("tenant_id", "operation", "key", "property_id")
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "api_idempotency"
        drop constraint "api_idempotency_unique"
    `);
    this.addSql(`
      alter table "api_idempotency"
        add constraint "api_idempotency_unique"
        unique ("tenant_id", "operation", "key")
    `);
    this.addSql(
      `alter table "room_assignment" drop constraint "room_assignment_no_overlap"`,
    );
    this.addSql(`
      alter table "room_assignment"
        add constraint "room_assignment_no_overlap"
        exclude using gist (
          "resource_id" with =,
          daterange("start_date", "end_date", '[)') with &&
        ) where ("state" in ('PLANNED', 'ACTIVE'))
    `);
  }
}
