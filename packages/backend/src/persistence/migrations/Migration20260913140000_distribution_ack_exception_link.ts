import { Migration } from '@mikro-orm/migrations';

export class Migration20260913140000_distribution_ack_exception_link extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "distribution_inbox_revision" add column "ack_exception_id" uuid`,
    );
    this.addSql(`
      update "distribution_inbox_revision" i
      set "ack_exception_id" = i."exception_id"
      where i."exception_id" is not null
        and exists (
          select 1 from "distribution_exception_case" e
          where e."id" = i."exception_id"
            and e."type" in ('ACK_EXHAUSTED', 'ACK_REJECTED', 'ACK_REQUEUED')
        )
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "distribution_inbox_revision" drop column if exists "ack_exception_id"`,
    );
  }
}
