import { Migration } from '@mikro-orm/migrations';

/** One durable preparation task for each vacated component of a stay event. */
export class Migration20261001090000_ops_task_components extends Migration {
  override async up(): Promise<void> {
    this.addSql('drop index "ops_task_source_unique"');
    this.addSql(`create unique index "ops_task_source_resource_unique"
      on "ops_task" ("tenant_id", "property_id", "source_event_id", "resource_id")
      nulls not distinct where "source_event_id" is not null`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from "ops_task" where "source_event_id" is not null
                 group by "tenant_id", "property_id", "source_event_id"
                 having count(*) > 1) then
        raise exception 'Component preparation tasks require a data-preserving forward fix';
      end if;
    end $$`);
    this.addSql('drop index "ops_task_source_resource_unique"');
    this.addSql(`create unique index "ops_task_source_unique"
      on "ops_task" ("tenant_id", "property_id", "source_event_id")
      where "source_event_id" is not null`);
  }
}
