import { Migration } from '@mikro-orm/migrations';

const derivedTables: Array<[string, 'connection' | 'outbox' | 'inbox']> = [
  ['distribution_channel_capability', 'connection'],
  ['distribution_mapping_version', 'connection'],
  ['distribution_external_booking', 'connection'],
  ['distribution_inbox_revision', 'connection'],
  ['distribution_sync_checkpoint', 'connection'],
  ['distribution_sync_attempt', 'outbox'],
  ['distribution_dedup_key', 'inbox'],
];

export class Migration20260913210000_distribution_tenant_consistency extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "distribution_consistency_conflict" (
        "id" uuid primary key default gen_random_uuid(),
        "table_name" varchar(100) not null,
        "row_id" uuid not null,
        "row_tenant_id" uuid,
        "parent_table" varchar(100) not null,
        "parent_id" uuid,
        "parent_tenant_id" uuid,
        "resolution" varchar(64) not null default 'QUARANTINED_NOT_VALID',
        "details_safe" jsonb not null default '{}',
        "detected_at" timestamptz not null default now()
      )
    `);
    this.addSql(
      `create index "distribution_conflict_table_idx" on "distribution_consistency_conflict" ("table_name", "detected_at")`,
    );

    for (const [table, parent] of derivedTables) {
      this.addSql(`alter table "${table}" add column "tenant_id" uuid`);
      this.addSql(`
        update "${table}" target
           set "tenant_id" = parent."tenant_id"
          from "${parent === 'connection' ? 'distribution_connection' : parent === 'outbox' ? 'distribution_outbox_event' : 'distribution_inbox_revision'}" parent
         where parent."id" = target."${
           parent === 'connection'
             ? 'connection_id'
             : parent === 'outbox'
               ? 'outbox_id'
               : 'inbox_revision_id'
         }"
           and target."tenant_id" is null
      `);
      this.addSql(
        `create index "${table}_tenant_idx" on "${table}" ("tenant_id")`,
      );
    }
    for (const [table, parent] of derivedTables)
      if (parent !== 'inbox')
        this.addSql(
          `alter table "${table}" alter column "tenant_id" set not null`,
        );

    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_outbox_event', o."id", o."tenant_id",
             'distribution_connection', c."id", c."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_outbox_event" o
        join "distribution_connection" c on c."id" = o."connection_id"
       where o."tenant_id" <> c."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_exception_case', e."id", e."tenant_id",
             'distribution_connection', c."id", c."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_exception_case" e
        join "distribution_connection" c on c."id" = e."connection_id"
       where e."tenant_id" <> c."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_exception_case', e."id", e."tenant_id",
             'distribution_inbox_revision', i."id", i."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_exception_case" e
        join "distribution_inbox_revision" i on i."id" = e."inbox_revision_id"
       where e."tenant_id" <> i."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_exception_case', e."id", e."tenant_id",
             'distribution_outbox_event', o."id", o."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_exception_case" e
        join "distribution_outbox_event" o on o."id" = e."outbox_id"
       where e."tenant_id" <> o."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_dead_letter', d."id", d."tenant_id",
             'distribution_connection', c."id", c."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_dead_letter" d
        join "distribution_connection" c on c."id" = d."connection_id"
       where d."tenant_id" <> c."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_dead_letter', d."id", d."tenant_id",
             'distribution_outbox_event', o."id", o."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_dead_letter" d
        join "distribution_outbox_event" o on o."id" = d."outbox_id"
       where d."tenant_id" <> o."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_inbox_revision', i."id", i."tenant_id",
             'distribution_external_booking', b."id", b."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch')
        from "distribution_inbox_revision" i
        join "distribution_external_booking" b on b."id" = i."external_booking_ref"
       where i."tenant_id" <> b."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_inbox_revision', i."id", i."tenant_id",
             'distribution_exception_case', e."id", e."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch', 'column', 'exception_id')
        from "distribution_inbox_revision" i
        join "distribution_exception_case" e on e."id" = i."exception_id"
       where i."tenant_id" <> e."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_inbox_revision', i."id", i."tenant_id",
             'distribution_exception_case', e."id", e."tenant_id",
             jsonb_build_object('reason', 'tenant_mismatch', 'column', 'ack_exception_id')
        from "distribution_inbox_revision" i
        join "distribution_exception_case" e on e."id" = i."ack_exception_id"
       where i."tenant_id" <> e."tenant_id"
    `);
    this.addSql(`
      insert into "distribution_consistency_conflict"
        ("table_name", "row_id", "row_tenant_id", "parent_table", "parent_id",
         "parent_tenant_id", "details_safe")
      select 'distribution_dedup_key', d."id", d."tenant_id",
             'distribution_inbox_revision', null, null,
             jsonb_build_object('reason', 'orphan_parent')
        from "distribution_dedup_key" d
       where d."inbox_revision_id" is null
    `);

    this.addSql(`
      create or replace function public.distribution_fill_tenant_from_connection()
      returns trigger
      language plpgsql
      as $$
      begin
        if new."tenant_id" is null then
          select c."tenant_id" into new."tenant_id"
            from "distribution_connection" c
           where c."id" = new."connection_id";
          if new."tenant_id" is null then
            raise exception 'distribution tenant derivation failed'
              using errcode = '42501';
          end if;
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create or replace function public.distribution_fill_tenant_from_outbox()
      returns trigger
      language plpgsql
      as $$
      begin
        if new."tenant_id" is null then
          select o."tenant_id" into new."tenant_id"
            from "distribution_outbox_event" o
           where o."id" = new."outbox_id";
          if new."tenant_id" is null then
            raise exception 'distribution tenant derivation failed'
              using errcode = '42501';
          end if;
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create or replace function public.distribution_fill_tenant_from_inbox()
      returns trigger
      language plpgsql
      as $$
      begin
        if new."tenant_id" is null and new."inbox_revision_id" is not null then
          select i."tenant_id" into new."tenant_id"
            from "distribution_inbox_revision" i
           where i."id" = new."inbox_revision_id";
          if new."tenant_id" is null then
            raise exception 'distribution tenant derivation failed'
              using errcode = '42501';
          end if;
        end if;
        return new;
      end
      $$
    `);

    for (const [table, parent] of derivedTables) {
      this.addSql(`
        create trigger "distribution_fill_tenant"
        before insert on "${table}"
        for each row execute function public.${
          parent === 'outbox'
            ? 'distribution_fill_tenant_from_outbox'
            : parent === 'inbox'
              ? 'distribution_fill_tenant_from_inbox'
              : 'distribution_fill_tenant_from_connection'
        }()
      `);
      this.addSql(`
        create trigger "prevent_tenant_id_change"
        before update on "${table}"
        for each row execute function public.prevent_tenant_id_change()
      `);
    }

    for (const table of [
      'distribution_connection',
      'distribution_external_booking',
      'distribution_exception_case',
      'distribution_inbox_revision',
      'distribution_outbox_event',
    ])
      this.addSql(
        `alter table "${table}" add constraint "${table}_tenant_id_unique" unique ("id", "tenant_id")`,
      );

    const compositeConstraints: string[] = [
      `alter table "distribution_channel_capability" add constraint "distribution_channel_capability_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id")`,
      `alter table "distribution_mapping_version" add constraint "distribution_mapping_version_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id")`,
      `alter table "distribution_external_booking" add constraint "distribution_external_booking_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id")`,
      `alter table "distribution_inbox_revision" add constraint "distribution_inbox_connection_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id")`,
      `alter table "distribution_sync_checkpoint" add constraint "distribution_sync_checkpoint_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id")`,
      `alter table "distribution_sync_attempt" add constraint "distribution_sync_attempt_tenant_fk" foreign key ("outbox_id", "tenant_id") references "distribution_outbox_event" ("id", "tenant_id")`,
      `alter table "distribution_dedup_key" add constraint "distribution_dedup_key_tenant_fk" foreign key ("inbox_revision_id", "tenant_id") references "distribution_inbox_revision" ("id", "tenant_id")`,
    ];
    for (const statement of compositeConstraints) this.addSql(statement);

    const quarantinedConstraints: Array<[string, string]> = [
      [
        'distribution_outbox_event',
        `alter table "distribution_outbox_event" add constraint "distribution_outbox_connection_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_exception_case',
        `alter table "distribution_exception_case" add constraint "distribution_exception_connection_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_exception_case',
        `alter table "distribution_exception_case" add constraint "distribution_exception_outbox_tenant_fk" foreign key ("outbox_id", "tenant_id") references "distribution_outbox_event" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_exception_case',
        `alter table "distribution_exception_case" add constraint "distribution_exception_inbox_tenant_fk" foreign key ("inbox_revision_id", "tenant_id") references "distribution_inbox_revision" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_dead_letter',
        `alter table "distribution_dead_letter" add constraint "distribution_dead_letter_connection_tenant_fk" foreign key ("connection_id", "tenant_id") references "distribution_connection" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_dead_letter',
        `alter table "distribution_dead_letter" add constraint "distribution_dead_letter_outbox_tenant_fk" foreign key ("outbox_id", "tenant_id") references "distribution_outbox_event" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_inbox_revision',
        `alter table "distribution_inbox_revision" add constraint "distribution_inbox_booking_tenant_fk" foreign key ("external_booking_ref", "tenant_id") references "distribution_external_booking" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_inbox_revision',
        `alter table "distribution_inbox_revision" add constraint "distribution_inbox_exception_tenant_fk" foreign key ("exception_id", "tenant_id") references "distribution_exception_case" ("id", "tenant_id") not valid`,
      ],
      [
        'distribution_inbox_revision',
        `alter table "distribution_inbox_revision" add constraint "distribution_inbox_ack_exception_tenant_fk" foreign key ("ack_exception_id", "tenant_id") references "distribution_exception_case" ("id", "tenant_id") not valid`,
      ],
    ];
    for (const [, statement] of quarantinedConstraints) this.addSql(statement);

    const tablesWithQuarantine = [
      'distribution_outbox_event',
      'distribution_exception_case',
      'distribution_dead_letter',
      'distribution_inbox_revision',
    ];
    for (const table of tablesWithQuarantine) {
      const names = quarantinedConstraints
        .filter(([name]) => name === table)
        .map(([, statement]) => {
          const match = statement.match(/add constraint "([^"]+)"/);
          return match?.[1] ?? '';
        })
        .filter(Boolean);
      this.addSql(`
        do $$
        begin
          if not exists (
            select 1 from "distribution_consistency_conflict"
             where "table_name" = '${table}'
          ) then
            ${names
              .map(
                (name) =>
                  `alter table "${table}" validate constraint "${name}";`,
              )
              .join('\n            ')}
          end if;
        end
        $$
      `);
    }
  }

  override async down(): Promise<void> {
    const constraintNames: Array<[string, string]> = [
      [
        'distribution_channel_capability',
        'distribution_channel_capability_tenant_fk',
      ],
      [
        'distribution_mapping_version',
        'distribution_mapping_version_tenant_fk',
      ],
      [
        'distribution_external_booking',
        'distribution_external_booking_tenant_fk',
      ],
      [
        'distribution_inbox_revision',
        'distribution_inbox_connection_tenant_fk',
      ],
      ['distribution_inbox_revision', 'distribution_inbox_booking_tenant_fk'],
      ['distribution_inbox_revision', 'distribution_inbox_exception_tenant_fk'],
      [
        'distribution_inbox_revision',
        'distribution_inbox_ack_exception_tenant_fk',
      ],
      [
        'distribution_sync_checkpoint',
        'distribution_sync_checkpoint_tenant_fk',
      ],
      ['distribution_sync_attempt', 'distribution_sync_attempt_tenant_fk'],
      ['distribution_dedup_key', 'distribution_dedup_key_tenant_fk'],
      ['distribution_outbox_event', 'distribution_outbox_connection_tenant_fk'],
      [
        'distribution_exception_case',
        'distribution_exception_connection_tenant_fk',
      ],
      [
        'distribution_exception_case',
        'distribution_exception_outbox_tenant_fk',
      ],
      ['distribution_exception_case', 'distribution_exception_inbox_tenant_fk'],
      [
        'distribution_dead_letter',
        'distribution_dead_letter_connection_tenant_fk',
      ],
      ['distribution_dead_letter', 'distribution_dead_letter_outbox_tenant_fk'],
    ];
    for (const [table, constraint] of constraintNames)
      this.addSql(
        `alter table "${table}" drop constraint if exists "${constraint}"`,
      );
    for (const table of [
      'distribution_connection',
      'distribution_external_booking',
      'distribution_exception_case',
      'distribution_inbox_revision',
      'distribution_outbox_event',
    ])
      this.addSql(
        `alter table "${table}" drop constraint if exists "${table}_tenant_id_unique"`,
      );
    for (const [table] of derivedTables) {
      this.addSql(
        `drop trigger if exists "distribution_fill_tenant" on "${table}"`,
      );
      this.addSql(
        `drop trigger if exists "prevent_tenant_id_change" on "${table}"`,
      );
      this.addSql(`drop index if exists "${table}_tenant_idx"`);
      this.addSql(`alter table "${table}" drop column if exists "tenant_id"`);
    }
    this.addSql(
      `drop function if exists public.distribution_fill_tenant_from_inbox()`,
    );
    this.addSql(
      `drop function if exists public.distribution_fill_tenant_from_outbox()`,
    );
    this.addSql(
      `drop function if exists public.distribution_fill_tenant_from_connection()`,
    );
    this.addSql(`drop table if exists "distribution_consistency_conflict"`);
  }
}
