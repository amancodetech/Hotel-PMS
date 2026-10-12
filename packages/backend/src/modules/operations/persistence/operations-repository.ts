import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { resourceLocationPathSql } from '../../property/persistence/resource-display.js';
import { one, rows } from '../../../persistence/sql.js';
import type { TaskStatus, TaskType } from '../domain/task-state.js';

export interface OperationsPolicyRow {
  id: string;
  tenant_id: string;
  property_id: string;
  inspection_required: boolean;
  long_stay_clean_interval_days: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OpsTaskRow {
  id: string;
  resource_code?: string | null;
  resource_display_label?: string | null;
  resource_location_path?: string[];
  tenant_id: string;
  property_id: string;
  type: TaskType;
  status: TaskStatus;
  source_event_id: string | null;
  source_event_type: string | null;
  resource_id: string | null;
  item_id: string | null;
  reservation_id: string | null;
  description: string | null;
  priority: number;
  due_date: string | null;
  policy_version: number | null;
  assignee_membership_id: string | null;
  created_by_membership_id: string | null;
  clean_started_at: string | null;
  clean_completed_at: string | null;
  inspected_at: string | null;
  inspected_by_membership_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OpsDndLogRow {
  id: string;
  tenant_id: string;
  property_id: string;
  resource_id: string;
  item_id: string | null;
  state: 'ACTIVE' | 'FOLLOWED_UP';
  note: string;
  follow_up_at: string | null;
  follow_up_note: string | null;
  follow_up_attempt_at: string | null;
  created_by_membership_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StayPrepEventRow {
  id: string;
  type: 'STAY_CHECKED_OUT' | 'STAY_MOVED';
  item_id: string;
  reservation_id: string;
  resource_id: string | null;
  payload: Record<string, unknown>;
}

const taskColumns = `"id", "tenant_id", "property_id", "type", "status",
  "source_event_id", "source_event_type", "resource_id", "item_id",
  "reservation_id", "description", "priority", "due_date", "policy_version",
  "assignee_membership_id", "created_by_membership_id", "clean_started_at",
  "clean_completed_at", "inspected_at", "inspected_by_membership_id",
  "version", "created_at", "updated_at"`;

export async function findActiveMembership(
  em: EntityManager,
  tenantId: string,
  userId: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "membership"
      where "tenant_id" = ? and "user_id" = ? and "status" = 'ACTIVE'`,
    [tenantId, userId],
  );
}

export async function findActiveMembershipById(
  em: EntityManager,
  tenantId: string,
  membershipId: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "membership"
      where "tenant_id" = ? and "id" = ? and "status" = 'ACTIVE'`,
    [tenantId, membershipId],
  );
}

export async function findOperationsPolicy(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<OperationsPolicyRow | null> {
  return one<OperationsPolicyRow>(
    em,
    `select * from "property_operations_policy"
      where "tenant_id" = ? and "property_id" = ?`,
    [tenantId, propertyId],
  );
}

export async function insertOperationsPolicy(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    inspectionRequired: boolean;
    longStayCleanIntervalDays: number | null;
  },
): Promise<OperationsPolicyRow> {
  const row = await one<OperationsPolicyRow>(
    em,
    `insert into "property_operations_policy"
       ("id", "tenant_id", "property_id", "inspection_required",
        "long_stay_clean_interval_days")
     values (?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.inspectionRequired,
      input.longStayCleanIntervalDays,
    ],
  );
  if (!row) throw new Error('operations policy insert returned no row');
  return row;
}

export async function updateOperationsPolicy(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    version: number;
    inspectionRequired: boolean;
    longStayCleanIntervalDays: number | null;
  },
): Promise<OperationsPolicyRow | null> {
  return one<OperationsPolicyRow>(
    em,
    `update "property_operations_policy"
        set "inspection_required" = ?,
            "long_stay_clean_interval_days" = ?,
            "version" = "version" + 1,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.inspectionRequired,
      input.longStayCleanIntervalDays,
      input.tenantId,
      input.propertyId,
      input.version,
    ],
  );
}

export async function findTask(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  taskId: string,
): Promise<OpsTaskRow | null> {
  return one<OpsTaskRow>(
    em,
    `select ${taskColumns} from "ops_task"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [taskId, tenantId, propertyId],
  );
}

export async function insertPrepTask(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    sourceEventId: string;
    sourceEventType: string;
    resourceId: string | null;
    itemId: string;
    reservationId: string;
    dueDate: string | null;
  },
): Promise<{ inserted: boolean; row: OpsTaskRow }> {
  const insertedRow = await one<OpsTaskRow>(
    em,
    `insert into "ops_task"
       ("id", "tenant_id", "property_id", "type", "status",
        "source_event_id", "source_event_type", "resource_id", "item_id",
        "reservation_id", "priority", "due_date")
     values (?, ?, ?, 'HOUSEKEEPING', 'PENDING', ?, ?, ?, ?, ?, 0, ?)
     on conflict ("tenant_id", "property_id", "source_event_id", "resource_id")
       where "source_event_id" is not null
     do nothing
     returning ${taskColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.sourceEventId,
      input.sourceEventType,
      input.resourceId,
      input.itemId,
      input.reservationId,
      input.dueDate,
    ],
  );
  if (insertedRow) return { inserted: true, row: insertedRow };
  const existing = await one<OpsTaskRow>(
    em,
    `select ${taskColumns} from "ops_task"
      where "tenant_id" = ? and "property_id" = ? and "source_event_id" = ?
        and "resource_id" is not distinct from ?::uuid`,
    [input.tenantId, input.propertyId, input.sourceEventId, input.resourceId],
  );
  if (!existing) throw new Error('ops_task conflict without existing row');
  return { inserted: false, row: existing };
}

export async function insertManualTask(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    type: TaskType;
    resourceId: string | null;
    itemId: string | null;
    reservationId: string | null;
    description: string;
    priority: number;
    dueDate: string | null;
    policyVersion: number | null;
    assigneeMembershipId: string | null;
    createdByMembershipId: string | null;
  },
): Promise<OpsTaskRow> {
  const row = await one<OpsTaskRow>(
    em,
    `insert into "ops_task"
       ("id", "tenant_id", "property_id", "type", "status", "resource_id",
        "item_id", "reservation_id", "description", "priority", "due_date",
        "policy_version", "assignee_membership_id",
        "created_by_membership_id")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning ${taskColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.type,
      input.assigneeMembershipId ? 'ASSIGNED' : 'PENDING',
      input.resourceId,
      input.itemId,
      input.reservationId,
      input.description,
      input.priority,
      input.dueDate,
      input.policyVersion,
      input.assigneeMembershipId,
      input.createdByMembershipId,
    ],
  );
  if (!row) throw new Error('ops task insert returned no row');
  return row;
}

export async function applyTaskTransition(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    taskId: string;
    expectedVersion: number;
    status: TaskStatus;
    assigneeMembershipId?: string | null;
    setAssignee?: boolean;
    cleanStartedAt?: string | null;
    cleanCompletedAt?: string | null;
    inspectedAt?: string | null;
    inspectedByMembershipId?: string | null;
  },
): Promise<OpsTaskRow | null> {
  return one<OpsTaskRow>(
    em,
    `update "ops_task"
        set "status" = ?,
            "assignee_membership_id" =
              case when ? then ?::uuid else "assignee_membership_id" end,
            "clean_started_at" = coalesce(?::timestamptz, "clean_started_at"),
            "clean_completed_at" = coalesce(?::timestamptz, "clean_completed_at"),
            "inspected_at" = coalesce(?::timestamptz, "inspected_at"),
            "inspected_by_membership_id" =
              coalesce(?::uuid, "inspected_by_membership_id"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning ${taskColumns}`,
    [
      input.status,
      input.setAssignee === true,
      input.assigneeMembershipId ?? null,
      input.cleanStartedAt ?? null,
      input.cleanCompletedAt ?? null,
      input.inspectedAt ?? null,
      input.inspectedByMembershipId ?? null,
      input.taskId,
      input.tenantId,
      input.propertyId,
      input.expectedVersion,
    ],
  );
}

export async function listTaskRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: {
    status?: TaskStatus | null;
    assigneeMembershipId?: string | null;
    resourceId?: string | null;
    itemId?: string | null;
    limit: number;
    cursor: string | null;
  },
): Promise<OpsTaskRow[]> {
  let afterCreatedAt: string | null = null;
  let afterId: string | null = null;
  if (options.cursor) {
    const separator = options.cursor.lastIndexOf('|');
    if (separator > 0) {
      afterCreatedAt = options.cursor.slice(0, separator);
      afterId = options.cursor.slice(separator + 1);
    }
  }
  return rows<OpsTaskRow>(
    em,
    `select t.*, r."code" as "resource_code",
            r."display_label" as "resource_display_label",
            ${resourceLocationPathSql} as "resource_location_path"
       from "ops_task" t
       left join "resource" r
         on r."id" = t."resource_id" and r."tenant_id" = t."tenant_id"
        and r."property_id" = t."property_id"
      where t."tenant_id" = ? and t."property_id" = ?
        and (?::varchar is null or t."status" = ?::varchar)
        and (?::uuid is null or t."assignee_membership_id" = ?::uuid)
        and (?::uuid is null or t."resource_id" = ?::uuid)
        and (?::uuid is null or t."item_id" = ?::uuid)
        and (
          ?::timestamptz is null
          or (t."created_at", t."id") > (?::timestamptz, ?::uuid)
        )
      order by t."created_at", t."id"
      limit ?`,
    [
      tenantId,
      propertyId,
      options.status ?? null,
      options.status ?? null,
      options.assigneeMembershipId ?? null,
      options.assigneeMembershipId ?? null,
      options.resourceId ?? null,
      options.resourceId ?? null,
      options.itemId ?? null,
      options.itemId ?? null,
      afterCreatedAt,
      afterCreatedAt,
      afterId,
      options.limit,
    ],
  );
}

export async function listOpenStayCleaningTasks(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
): Promise<OpsTaskRow[]> {
  return rows<OpsTaskRow>(
    em,
    `select ${taskColumns} from "ops_task"
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "type" = 'HOUSEKEEPING' and "status" <> 'CANCELLED'
      order by "created_at" desc, "id" desc`,
    [tenantId, propertyId, itemId],
  );
}

export async function listUnconsumedStayPrepEvents(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<StayPrepEventRow[]> {
  return rows<StayPrepEventRow>(
    em,
    `select e."id", e."type", e."item_id", e."reservation_id",
            e."resource_id", e."payload"
       from "stay_event" e
      where e."tenant_id" = ? and e."property_id" = ?
        and e."type" in ('STAY_CHECKED_OUT', 'STAY_MOVED')
        and exists (
          select 1 from jsonb_array_elements_text(
            case when e."type" = 'STAY_CHECKED_OUT'
                      and jsonb_typeof(e."payload"->'resource_ids') = 'array'
                      and jsonb_array_length(e."payload"->'resource_ids') > 0
                 then e."payload"->'resource_ids'
                 else jsonb_build_array(case when e."type" = 'STAY_CHECKED_OUT'
                   then coalesce(e."payload"->>'resource_id', e."resource_id"::text)
                   else e."payload"->>'from_resource_id' end) end
          ) expected(resource_id)
          where expected.resource_id is not null and not exists (
            select 1 from "ops_task" t
             where t."source_event_id" = e."id"
               and t."tenant_id" = e."tenant_id"
               and t."property_id" = e."property_id"
               and t."resource_id"::text = expected.resource_id
          )
        )
      order by e."occurred_at", e."id"`,
    [tenantId, propertyId],
  );
}

export async function hasRecentStayCleaning(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
  intervalDays: number,
): Promise<boolean> {
  const row = await one<{ present: number }>(
    em,
    `select 1 as present from "ops_task"
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "type" = 'HOUSEKEEPING' and "status" <> 'CANCELLED'
        and "created_at" > now() - make_interval(days => ?::int)
      limit 1`,
    [tenantId, propertyId, itemId, intervalDays],
  );
  return row !== null;
}

export async function insertDndLog(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
    itemId: string | null;
    note: string;
    followUpAt: string | null;
    createdByMembershipId: string | null;
  },
): Promise<OpsDndLogRow> {
  const row = await one<OpsDndLogRow>(
    em,
    `insert into "ops_dnd_log"
       ("id", "tenant_id", "property_id", "resource_id", "item_id", "note",
        "follow_up_at", "created_by_membership_id")
     values (?, ?, ?, ?, ?, ?, ?::timestamptz, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.resourceId,
      input.itemId,
      input.note,
      input.followUpAt,
      input.createdByMembershipId,
    ],
  );
  if (!row) throw new Error('dnd log insert returned no row');
  return row;
}

export async function findDndLog(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  dndId: string,
): Promise<OpsDndLogRow | null> {
  return one<OpsDndLogRow>(
    em,
    `select * from "ops_dnd_log"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [dndId, tenantId, propertyId],
  );
}

export async function listDndLogRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: {
    resourceId?: string | null;
    state?: string | null;
    limit: number;
    cursor: string | null;
  },
): Promise<OpsDndLogRow[]> {
  let afterCreatedAt: string | null = null;
  let afterId: string | null = null;
  if (options.cursor) {
    const separator = options.cursor.lastIndexOf('|');
    if (separator > 0) {
      afterCreatedAt = options.cursor.slice(0, separator);
      afterId = options.cursor.slice(separator + 1);
    }
  }
  return rows<OpsDndLogRow>(
    em,
    `select * from "ops_dnd_log"
      where "tenant_id" = ? and "property_id" = ?
        and (?::uuid is null or "resource_id" = ?::uuid)
        and (?::varchar is null or "state" = ?::varchar)
        and (
          ?::timestamptz is null
          or ("created_at", "id") > (?::timestamptz, ?::uuid)
        )
      order by "created_at", "id"
      limit ?`,
    [
      tenantId,
      propertyId,
      options.resourceId ?? null,
      options.resourceId ?? null,
      options.state ?? null,
      options.state ?? null,
      afterCreatedAt,
      afterCreatedAt,
      afterId,
      options.limit,
    ],
  );
}

export async function markDndFollowedUp(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    dndId: string;
    attemptAt: string;
    note: string;
  },
): Promise<OpsDndLogRow | null> {
  return one<OpsDndLogRow>(
    em,
    `update "ops_dnd_log"
        set "state" = 'FOLLOWED_UP',
            "follow_up_attempt_at" = ?::timestamptz,
            "follow_up_note" = ?,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'ACTIVE'
      returning *`,
    [
      input.attemptAt,
      input.note,
      input.dndId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export interface WorkOrderRow {
  id: string;
  resource_code?: string | null;
  resource_display_label?: string | null;
  resource_location_path?: string[];
  tenant_id: string;
  property_id: string;
  resource_id: string;
  category: string;
  severity: string;
  impact: 'NONE' | 'OOS' | 'OOO';
  emergency: boolean;
  status: string;
  description: string;
  period_start: string | null;
  period_end: string | null;
  block_id: string | null;
  assignee_membership_id: string | null;
  resolution_note: string | null;
  verified_at: string | null;
  verified_by_membership_id: string | null;
  closed_at: string | null;
  reopen_count: number;
  last_reopen_reason: string | null;
  created_by_membership_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const workOrderColumns = `"id", "tenant_id", "property_id", "resource_id",
  "category", "severity", "impact", "emergency", "status", "description",
  "period_start", "period_end", "block_id", "assignee_membership_id",
  "resolution_note", "verified_at", "verified_by_membership_id", "closed_at",
  "reopen_count", "last_reopen_reason", "created_by_membership_id",
  "version", "created_at", "updated_at"`;

export async function insertWorkOrder(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
    category: string;
    severity: string;
    impact: string;
    emergency: boolean;
    description: string;
    periodStart: string | null;
    periodEnd: string | null;
    blockId: string | null;
    assigneeMembershipId: string | null;
    createdByMembershipId: string | null;
  },
): Promise<WorkOrderRow> {
  const row = await one<WorkOrderRow>(
    em,
    `insert into "ops_work_order"
       ("id", "tenant_id", "property_id", "resource_id", "category",
        "severity", "impact", "emergency", "status", "description",
        "period_start", "period_end", "block_id", "assignee_membership_id",
        "created_by_membership_id")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?, ?, ?)
     returning ${workOrderColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.resourceId,
      input.category,
      input.severity,
      input.impact,
      input.emergency,
      input.assigneeMembershipId ? 'ASSIGNED' : 'OPEN',
      input.description,
      input.periodStart,
      input.periodEnd,
      input.blockId,
      input.assigneeMembershipId,
      input.createdByMembershipId,
    ],
  );
  if (!row) throw new Error('work order insert returned no row');
  return row;
}

export async function findWorkOrder(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  workOrderId: string,
): Promise<WorkOrderRow | null> {
  return one<WorkOrderRow>(
    em,
    `select ${workOrderColumns} from "ops_work_order"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [workOrderId, tenantId, propertyId],
  );
}

export async function applyWorkOrderTransition(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    workOrderId: string;
    expectedVersion: number;
    status: string;
    setAssignee?: boolean;
    assigneeMembershipId?: string | null;
    resolutionNote?: string | null;
    verifiedAt?: string | null;
    verifiedByMembershipId?: string | null;
    closedAt?: string | null;
    clearClosedAt?: boolean;
    reopenCount?: number | null;
    lastReopenReason?: string | null;
  },
): Promise<WorkOrderRow | null> {
  return one<WorkOrderRow>(
    em,
    `update "ops_work_order"
        set "status" = ?,
            "assignee_membership_id" =
              case when ? then ?::uuid else "assignee_membership_id" end,
            "resolution_note" = coalesce(?::text, "resolution_note"),
            "verified_at" = coalesce(?::timestamptz, "verified_at"),
            "verified_by_membership_id" =
              coalesce(?::uuid, "verified_by_membership_id"),
            "closed_at" = case
              when ? then ?::timestamptz
              when ? then null
              else "closed_at" end,
            "reopen_count" = coalesce(?::int, "reopen_count"),
            "last_reopen_reason" = coalesce(?::text, "last_reopen_reason"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning ${workOrderColumns}`,
    [
      input.status,
      input.setAssignee === true,
      input.assigneeMembershipId ?? null,
      input.resolutionNote ?? null,
      input.verifiedAt ?? null,
      input.verifiedByMembershipId ?? null,
      input.closedAt !== undefined && input.closedAt !== null,
      input.closedAt ?? null,
      input.clearClosedAt === true,
      input.reopenCount ?? null,
      input.lastReopenReason ?? null,
      input.workOrderId,
      input.tenantId,
      input.propertyId,
      input.expectedVersion,
    ],
  );
}

export async function listWorkOrderRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: {
    status?: string | null;
    resourceId?: string | null;
    assigneeMembershipId?: string | null;
    limit: number;
    cursor: string | null;
  },
): Promise<WorkOrderRow[]> {
  let afterCreatedAt: string | null = null;
  let afterId: string | null = null;
  if (options.cursor) {
    const separator = options.cursor.lastIndexOf('|');
    if (separator > 0) {
      afterCreatedAt = options.cursor.slice(0, separator);
      afterId = options.cursor.slice(separator + 1);
    }
  }
  return rows<WorkOrderRow>(
    em,
    `select w.*, r."code" as "resource_code",
            r."display_label" as "resource_display_label",
            ${resourceLocationPathSql} as "resource_location_path"
       from "ops_work_order" w
       left join "resource" r
         on r."id" = w."resource_id" and r."tenant_id" = w."tenant_id"
        and r."property_id" = w."property_id"
      where w."tenant_id" = ? and w."property_id" = ?
        and (?::varchar is null or w."status" = ?::varchar)
        and (?::uuid is null or w."resource_id" = ?::uuid)
        and (?::uuid is null or w."assignee_membership_id" = ?::uuid)
        and (
          ?::timestamptz is null
          or (w."created_at", w."id") > (?::timestamptz, ?::uuid)
        )
      order by w."created_at", w."id"
      limit ?`,
    [
      tenantId,
      propertyId,
      options.status ?? null,
      options.status ?? null,
      options.resourceId ?? null,
      options.resourceId ?? null,
      options.assigneeMembershipId ?? null,
      options.assigneeMembershipId ?? null,
      afterCreatedAt,
      afterCreatedAt,
      afterId,
      options.limit,
    ],
  );
}

export async function listOpenWorkOrderImpacts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
): Promise<Array<'NONE' | 'OOS' | 'OOO'>> {
  const rowsResult = await rows<{ impact: 'NONE' | 'OOS' | 'OOO' }>(
    em,
    `select "impact" from "ops_work_order"
      where "tenant_id" = ? and "property_id" = ? and "resource_id" = ?
        and "status" <> 'CLOSED'`,
    [tenantId, propertyId, resourceId],
  );
  return rowsResult.map((row) => row.impact);
}

export interface ShiftHandoverRow {
  id: string;
  tenant_id: string;
  property_id: string;
  shift_date: string;
  from_membership_id: string | null;
  to_membership_id: string | null;
  follow_up_membership_id: string | null;
  open_tasks: number;
  open_work_orders: number;
  active_dnd: number;
  cashier_session_id: string | null;
  cashier_currency: string | null;
  cashier_expected_amount: string | null;
  cashier_counted_amount: string | null;
  cashier_variance: string | null;
  exceptions_text: string | null;
  note: string | null;
  created_by_membership_id: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  recipient_membership_id: string | null;
  created_at: string;
  read_at: string | null;
}

export async function countOpenTasks(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const [row] = await rows<{ count: number }>(
    em,
    `select count(*)::int as "count" from "ops_task"
      where "tenant_id" = ? and "property_id" = ?
        and "status" not in ('INSPECTED', 'CANCELLED')`,
    [tenantId, propertyId],
  );
  return row?.count ?? 0;
}

export async function countOpenWorkOrders(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const [row] = await rows<{ count: number }>(
    em,
    `select count(*)::int as "count" from "ops_work_order"
      where "tenant_id" = ? and "property_id" = ? and "status" <> 'CLOSED'`,
    [tenantId, propertyId],
  );
  return row?.count ?? 0;
}

export async function countActiveDnd(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const [row] = await rows<{ count: number }>(
    em,
    `select count(*)::int as "count" from "ops_dnd_log"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'ACTIVE'`,
    [tenantId, propertyId],
  );
  return row?.count ?? 0;
}

export async function insertShiftHandover(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    shiftDate: string;
    fromMembershipId: string | null;
    toMembershipId: string | null;
    followUpMembershipId: string | null;
    openTasks: number;
    openWorkOrders: number;
    activeDnd: number;
    cashierSessionId: string | null;
    cashierCurrency: string | null;
    cashierExpectedAmount: string | null;
    cashierCountedAmount: string | null;
    cashierVariance: string | null;
    exceptionsText: string | null;
    note: string | null;
    createdByMembershipId: string | null;
  },
): Promise<ShiftHandoverRow> {
  const row = await one<ShiftHandoverRow>(
    em,
    `insert into "ops_shift_handover"
       ("id", "tenant_id", "property_id", "shift_date", "from_membership_id",
        "to_membership_id", "follow_up_membership_id", "open_tasks",
        "open_work_orders", "active_dnd", "cashier_session_id",
        "cashier_currency", "cashier_expected_amount", "cashier_counted_amount",
        "cashier_variance", "exceptions_text", "note", "created_by_membership_id")
     values (?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric,
             ?::numeric, ?::numeric, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.shiftDate,
      input.fromMembershipId,
      input.toMembershipId,
      input.followUpMembershipId,
      input.openTasks,
      input.openWorkOrders,
      input.activeDnd,
      input.cashierSessionId,
      input.cashierCurrency,
      input.cashierExpectedAmount,
      input.cashierCountedAmount,
      input.cashierVariance,
      input.exceptionsText,
      input.note,
      input.createdByMembershipId,
    ],
  );
  if (!row) throw new Error('shift handover insert returned no row');
  return row;
}

export async function listShiftHandoverRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  limit: number,
): Promise<ShiftHandoverRow[]> {
  return rows<ShiftHandoverRow>(
    em,
    `select * from "ops_shift_handover"
      where "tenant_id" = ? and "property_id" = ?
      order by "created_at" desc, "id" desc
      limit ?`,
    [tenantId, propertyId, limit],
  );
}

export async function insertNotification(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    type: string;
    severity: string;
    title: string;
    body: string | null;
    resourceType: string | null;
    resourceId: string | null;
    recipientMembershipId: string | null;
  },
): Promise<NotificationRow> {
  const row = await one<NotificationRow>(
    em,
    `insert into "ops_notification"
       ("id", "tenant_id", "property_id", "type", "severity", "title",
        "body", "resource_type", "resource_id", "recipient_membership_id")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *, null::timestamptz as "read_at"`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.type,
      input.severity,
      input.title,
      input.body,
      input.resourceType,
      input.resourceId,
      input.recipientMembershipId,
    ],
  );
  if (!row) throw new Error('notification insert returned no row');
  return row;
}

export async function listNotificationRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  membershipId: string | null,
  limit: number,
): Promise<NotificationRow[]> {
  return rows<NotificationRow>(
    em,
    `select n."id", n."tenant_id", n."property_id", n."type", n."severity",
            n."title", n."body", n."resource_type", n."resource_id",
            n."recipient_membership_id", n."created_at", r."read_at"
       from "ops_notification" n
       left join "ops_notification_receipt" r
         on r."notification_id" = n."id" and r."membership_id" = ?
      where n."tenant_id" = ? and n."property_id" = ?
        and (n."recipient_membership_id" is null
             or n."recipient_membership_id" = ?::uuid)
      order by n."created_at" desc, n."id" desc
      limit ?`,
    [membershipId, tenantId, propertyId, membershipId, limit],
  );
}

export async function findNotification(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  notificationId: string,
): Promise<NotificationRow | null> {
  return one<NotificationRow>(
    em,
    `select n."id", n."tenant_id", n."property_id", n."type", n."severity",
            n."title", n."body", n."resource_type", n."resource_id",
            n."recipient_membership_id", n."created_at", null::timestamptz as "read_at"
       from "ops_notification" n
      where n."id" = ? and n."tenant_id" = ? and n."property_id" = ?`,
    [notificationId, tenantId, propertyId],
  );
}

export async function insertNotificationReceipt(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    notificationId: string;
    membershipId: string;
  },
): Promise<boolean> {
  const row = await one<{ notification_id: string }>(
    em,
    `insert into "ops_notification_receipt"
       ("notification_id", "membership_id", "tenant_id", "property_id")
     values (?, ?, ?, ?)
     on conflict ("notification_id", "membership_id") do nothing
     returning "notification_id"`,
    [
      input.notificationId,
      input.membershipId,
      input.tenantId,
      input.propertyId,
    ],
  );
  return row !== null;
}

export async function findPropertyScopeRow(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<{ id: string; timezone: string } | null> {
  return one<{ id: string; timezone: string }>(
    em,
    `select "id", "timezone" from "property"
      where "id" = ? and "tenant_id" = ?`,
    [propertyId, tenantId],
  );
}
