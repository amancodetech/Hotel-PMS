import { Migration } from '@mikro-orm/migrations';
export class Migration20260927120000_setup_batch extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table property_setup_batch (
      id uuid primary key, tenant_id uuid not null, property_id uuid not null,
      mode text not null check(mode in ('DRAFT','ADDITION')),
      draft_id uuid, draft_revision integer,
      input jsonb not null, chunks jsonb not null, results jsonb not null default '[]',
      next_index integer not null default 0 check(next_index >= 0),
      completed boolean not null default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      foreign key(property_id,tenant_id) references property(id,tenant_id),
      check(next_index <= jsonb_array_length(chunks)),
      check(completed = (next_index = jsonb_array_length(chunks)))
    )`);
    this.addSql(
      `create unique index property_setup_batch_running on property_setup_batch(tenant_id,property_id) where not completed`,
    );
    this.addSql(`alter table property_setup_batch enable row level security`);
    this.addSql(`alter table property_setup_batch force row level security`);
    this.addSql(
      `create policy tenant_isolation on property_setup_batch using (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)`,
    );
    this.addSql(
      `create trigger prevent_tenant_id_change before update on property_setup_batch for each row execute function public.prevent_tenant_id_change()`,
    );
    this.addSql(
      `grant select,insert,update on property_setup_batch to hotel_api,hotel_test`,
    );
  }
  override async down(): Promise<void> {
    throw new Error(
      'Setup batch history requires an explicit data-preserving rollback',
    );
  }
}
