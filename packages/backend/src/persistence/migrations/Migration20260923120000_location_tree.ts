import { Migration } from '@mikro-orm/migrations';

export class Migration20260923120000_location_tree extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table property add location_tree_revision bigint not null default 0`,
    );
    this.addSql(`alter table location
      add parent_id uuid,
      add kind text check (kind in ('ZONE','BUILDING','WING','FLOOR','CLUSTER','SERVICE_AREA')),
      add display_order integer not null default 0 check (display_order >= 0),
      add constraint location_parent_scope_fk foreign key (parent_id, property_id, tenant_id)
        references location(id, property_id, tenant_id),
      add constraint location_not_self check (parent_id is distinct from id)`);
    this.addSql(`create index location_children_order_idx on location
      (tenant_id, property_id, parent_id, display_order, code, id)`);
    this.addSql(`alter table resource
      add display_label varchar(160),
      add unit_details jsonb not null default '{}'::jsonb,
      add constraint resource_display_label_check check (display_label is null or length(btrim(display_label)) > 0),
      add constraint resource_unit_details_check check (
        jsonb_typeof(unit_details) = 'object' and
        unit_details - 'bedrooms_count' - 'bathrooms_count' - 'notes' = '{}'::jsonb and
        (not (unit_details ? 'bedrooms_count') or
          (jsonb_typeof(unit_details->'bedrooms_count') = 'number' and (unit_details->>'bedrooms_count')::numeric between 0 and 100 and mod((unit_details->>'bedrooms_count')::numeric,1) = 0)) and
        (not (unit_details ? 'bathrooms_count') or
          (jsonb_typeof(unit_details->'bathrooms_count') = 'number' and (unit_details->>'bathrooms_count')::numeric between 0 and 100 and mod((unit_details->>'bathrooms_count')::numeric,1) = 0)) and
        (not (unit_details ? 'notes') or (jsonb_typeof(unit_details->'notes') = 'string' and length(unit_details->>'notes') <= 1000))
      )`);
    // Common property lock serializes API writers. Trigger also protects direct writes.
    this
      .addSql(`create function guard_location_tree() returns trigger language plpgsql as $$
    declare ancestor_count integer; subtree_depth integer; cyclic boolean;
    begin
      perform 1 from property where id = NEW.property_id and tenant_id = NEW.tenant_id for update;
      with recursive ancestors as (
        select id, parent_id, array[id] as visited, 1 as depth from location
          where id = NEW.parent_id and property_id = NEW.property_id and tenant_id = NEW.tenant_id
        union all
        select l.id,l.parent_id,a.visited || l.id,a.depth+1 from location l join ancestors a on l.id=a.parent_id
          where l.property_id=NEW.property_id and l.tenant_id=NEW.tenant_id and not l.id=any(a.visited) and a.depth<=32
      ) select coalesce(max(depth),0),coalesce(bool_or(id=NEW.id),false) into ancestor_count,cyclic from ancestors;
      if cyclic or NEW.id=NEW.parent_id then
        raise exception 'location cycle' using errcode='23514', constraint='location_cycle';
      end if;
      with recursive descendants as (
        select NEW.id as id, 1 as depth, array[NEW.id] as visited
        union all
        select l.id,d.depth+1,d.visited || l.id from location l join descendants d on l.parent_id=d.id
          where l.property_id=NEW.property_id and l.tenant_id=NEW.tenant_id and not l.id=any(d.visited) and d.depth<=32
      ) select max(depth) into subtree_depth from descendants;
      if ancestor_count+subtree_depth>32 then
        raise exception 'location depth exceeds 32' using errcode='23514',constraint='location_depth';
      end if;
      return NEW;
    end $$`);
    this
      .addSql(`create trigger location_tree_guard before insert or update of parent_id on location
      for each row execute function guard_location_tree()`);
    this
      .addSql(`create function bump_location_tree_revision() returns trigger language plpgsql as $$
      begin
        update property set location_tree_revision=location_tree_revision+1
          where id=coalesce(NEW.property_id,OLD.property_id) and tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id);
        return null;
      end $$`);
    this
      .addSql(`create trigger location_tree_revision after insert or update or delete on location
      for each row execute function bump_location_tree_revision()`);
  }

  override async down(): Promise<void> {
    // Refuse before any DDL: rollback must not discard values or falsify migration history.
    this.addSql(
      `lock table property, location, resource in access exclusive mode`,
    );
    this.addSql(`do $$ begin
      if exists(select 1 from location where parent_id is not null or kind is not null or display_order<>0)
        or exists(select 1 from resource where display_label is not null or unit_details<>'{}'::jsonb)
      then raise exception 'PSR03_DOWNGRADE_BLOCKED: export/restore required for tree or unit details'; end if;
    end $$`);
    this.addSql(`drop trigger location_tree_revision on location`);
    this.addSql(`drop trigger location_tree_guard on location`);
    this.addSql(`drop function bump_location_tree_revision()`);
    this.addSql(`drop function guard_location_tree()`);
    this.addSql(
      `alter table location drop column parent_id, drop column kind, drop column display_order`,
    );
    this.addSql(
      `alter table resource drop column display_label, drop column unit_details`,
    );
    this.addSql(`alter table property drop column location_tree_revision`);
  }
}
