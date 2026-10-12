/** Read-only display projection for queries whose scoped resource alias is r.
 * A bed inherits the nearest container location when it has none of its own.
 * Both walks retain tenant/property scope and stop at previously visited IDs.
 */
export const resourceLocationPathSql = `(with recursive containers as (
  select r."id", r."parent_resource_id", r."location_id", 0 as depth,
         array[r."id"] as visited
  union all
  select parent."id", parent."parent_resource_id", parent."location_id",
         child.depth + 1, child.visited || parent."id"
    from containers child join "resource" parent
      on parent."id" = child."parent_resource_id"
     and parent."tenant_id" = r."tenant_id"
     and parent."property_id" = r."property_id"
   where not parent."id" = any(child.visited)
), places as (
  select l."id", l."parent_id", array[l."name"]::text[] as path,
         array[l."id"] as visited
    from "location" l
   where l."id" = (select "location_id" from containers
                    where "location_id" is not null order by depth limit 1)
     and l."tenant_id" = r."tenant_id" and l."property_id" = r."property_id"
  union all
  select parent."id", parent."parent_id", parent."name" || child.path,
         child.visited || parent."id"
    from places child join "location" parent on parent."id" = child."parent_id"
     and parent."tenant_id" = r."tenant_id"
     and parent."property_id" = r."property_id"
   where not parent."id" = any(child.visited)
)
select coalesce((select path from places order by cardinality(path) desc limit 1),
                array[]::text[]))`;
