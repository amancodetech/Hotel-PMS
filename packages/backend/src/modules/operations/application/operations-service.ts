import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  findResource,
  updateResourceHousekeeping,
} from '../../property/persistence/resource-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import { findReservationItem } from '../../reservations/persistence/reservation-repository.js';
import {
  assertTaskAssignable,
  assertTaskTransition,
  isTaskType,
} from '../domain/task-state.js';
import type { TaskStatus, TaskType } from '../domain/task-state.js';
import * as repo from '../persistence/operations-repository.js';
import { emitNotification } from './shift-handover-service.js';

export interface StayPrepEventInput {
  id: string;
  type: string;
  item_id: string;
  reservation_id: string;
  resource_id: string | null;
  payload: Record<string, unknown>;
}

export interface CreateTaskInput {
  type: string;
  description: string;
  resource_id?: string | null;
  item_id?: string | null;
  assignee_membership_id?: string | null;
  priority?: number;
  due_date?: string | null;
  idempotencyKey?: string | null;
}

export interface ListTasksInput {
  status?: string | null;
  assignee_membership_id?: string | null;
  resource_id?: string | null;
  item_id?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface TaskCommandInput {
  version: number;
  idempotencyKey?: string | null;
  note?: string | null;
}

export interface LogDndInput {
  resource_id: string;
  item_id?: string | null;
  note: string;
  follow_up_at?: string | null;
  idempotencyKey?: string | null;
}

export interface FollowUpDndInput {
  note: string;
  idempotencyKey?: string | null;
}

export interface SetOperationsPolicyInput {
  inspection_required: boolean;
  long_stay_clean_interval_days?: number | null;
  version?: number | null;
  idempotencyKey?: string | null;
}

function taskView(row: repo.OpsTaskRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    resource_id: row.resource_id,
    resource_code: row.resource_code ?? null,
    resource_display_label: row.resource_display_label ?? null,
    resource_location_path: row.resource_location_path ?? [],
    item_id: row.item_id,
    reservation_id: row.reservation_id,
    description: row.description,
    priority: row.priority,
    due_date: row.due_date,
    policy_version: row.policy_version,
    assignee_membership_id: row.assignee_membership_id,
    source_event_id: row.source_event_id,
    source_event_type: row.source_event_type,
    clean_started_at: row.clean_started_at,
    clean_completed_at: row.clean_completed_at,
    inspected_at: row.inspected_at,
    inspected_by_membership_id: row.inspected_by_membership_id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function dndView(row: repo.OpsDndLogRow) {
  return {
    id: row.id,
    resource_id: row.resource_id,
    item_id: row.item_id,
    state: row.state,
    note: row.note,
    follow_up_at: row.follow_up_at,
    follow_up_note: row.follow_up_note,
    follow_up_attempt_at: row.follow_up_attempt_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function policyView(row: repo.OperationsPolicyRow | null) {
  if (!row)
    return {
      configured: false,
      inspection_required: false,
      long_stay_clean_interval_days: null,
      version: null,
    };
  return {
    configured: true,
    inspection_required: row.inspection_required,
    long_stay_clean_interval_days: row.long_stay_clean_interval_days,
    version: row.version,
  };
}

async function actorMembershipId(
  em: EntityManager,
  context: ServiceContext,
): Promise<string | null> {
  const membership = await repo.findActiveMembership(
    em,
    context.tenantId,
    context.actor.userId,
  );
  return membership?.id ?? null;
}

async function requireTask(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  taskId: string,
): Promise<repo.OpsTaskRow> {
  const task = await repo.findTask(em, tenantId, propertyId, taskId);
  if (!task) throw new PropertyError('NOT_FOUND');
  return task;
}

async function resolveTaskWrite(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  taskId: string,
  expectedVersion: number,
  row: repo.OpsTaskRow | null,
): Promise<repo.OpsTaskRow> {
  if (row) return row;
  const fresh = await repo.findTask(em, tenantId, propertyId, taskId);
  if (!fresh) throw new PropertyError('NOT_FOUND');
  if (fresh.version !== expectedVersion)
    throw new PropertyError('STALE_VERSION', {
      expected: expectedVersion,
      current: fresh.version,
    });
  throw new PropertyError('INVALID_STATE_TRANSITION', { state: fresh.status });
}

export async function createTask(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: CreateTaskInput,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CreateTask',
    type: input.type,
    resource_id: input.resource_id ?? null,
    item_id: input.item_id ?? null,
    assignee_membership_id: input.assignee_membership_id ?? null,
    priority: input.priority ?? 0,
    due_date: input.due_date ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CreateTask',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      if (input.type === 'MAINTENANCE')
        throw new PropertyError('INVALID_REQUEST', {
          field: 'type',
          reason: 'maintenance_work_order_required',
        });
      if (!isTaskType(input.type))
        throw new PropertyError('INVALID_REQUEST', { field: 'type' });
      const taskType: TaskType = input.type;
      const description = assertSafeText(
        input.description,
        'description',
        1000,
      );
      const priority = input.priority ?? 0;
      if (!Number.isInteger(priority) || priority < 0 || priority > 9)
        throw new PropertyError('INVALID_REQUEST', { field: 'priority' });
      const dueDate = input.due_date
        ? assertIsoDate(input.due_date, 'due_date')
        : null;
      let resource: Awaited<ReturnType<typeof findResource>> = null;
      if (input.resource_id) {
        resource = await findResource(
          em,
          context.tenantId,
          propertyId,
          input.resource_id,
        );
        if (!resource) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      let item: Awaited<ReturnType<typeof findReservationItem>> = null;
      if (input.item_id) {
        item = await findReservationItem(
          em,
          context.tenantId,
          propertyId,
          input.item_id,
        );
        if (!item) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      let policyVersion: number | null = null;
      if (taskType === 'HOUSEKEEPING' && item) {
        const policy = await repo.findOperationsPolicy(
          em,
          context.tenantId,
          propertyId,
        );
        if (!policy || policy.long_stay_clean_interval_days === null)
          throw new PropertyError('LONG_STAY_POLICY_MISSING');
        const recent = await repo.hasRecentStayCleaning(
          em,
          context.tenantId,
          propertyId,
          item.id,
          policy.long_stay_clean_interval_days,
        );
        if (recent)
          throw new PropertyError('INTERVAL_NOT_ELAPSED', {
            interval_days: policy.long_stay_clean_interval_days,
          });
        policyVersion = policy.version;
      }
      let assignee: string | null = null;
      if (input.assignee_membership_id) {
        const membership = await repo.findActiveMembershipById(
          em,
          context.tenantId,
          input.assignee_membership_id,
        );
        if (!membership) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        assignee = membership.id;
      }
      const createdByMembershipId = await actorMembershipId(em, context);
      const row = await translatePropertyWrite(() =>
        repo.insertManualTask(em, {
          tenantId: context.tenantId,
          propertyId,
          type: taskType,
          resourceId: resource?.id ?? null,
          itemId: item?.id ?? null,
          reservationId: item?.reservation_id ?? null,
          description,
          priority,
          dueDate,
          policyVersion,
          assigneeMembershipId: assignee,
          createdByMembershipId,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.task_created',
        resourceType: 'OpsTask',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          type: row.type,
          status: row.status,
          resource_id: row.resource_id,
          item_id: row.item_id,
          priority: row.priority,
          due_date: row.due_date,
          assignee_membership_id: row.assignee_membership_id,
        },
        correlationId: context.correlationId,
      });
      const response = { task: taskView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CreateTask',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function listTasks(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ListTasksInput,
): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  const status = input.status ?? null;
  if (
    status &&
    ![
      'PENDING',
      'ASSIGNED',
      'IN_PROGRESS',
      'CLEAN',
      'INSPECTED',
      'CANCELLED',
    ].includes(status)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const tasks = await repo.listTaskRows(em, context.tenantId, propertyId, {
        status: status as TaskStatus | null,
        assigneeMembershipId: input.assignee_membership_id ?? null,
        resourceId: input.resource_id ?? null,
        itemId: input.item_id ?? null,
        limit,
        cursor: input.cursor ?? null,
      });
      return {
        tasks: tasks.map(taskView),
        next_cursor:
          tasks.length === limit
            ? `${tasks[tasks.length - 1]?.created_at}|${tasks[tasks.length - 1]?.id}`
            : null,
      };
    },
  );
}

export async function assignTask(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  taskId: string,
  input: {
    membership_id: string;
    version: number;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'AssignTask',
    task_id: taskId,
    membership_id: input.membership_id,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'AssignTask',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const task = await requireTask(em, context.tenantId, propertyId, taskId);
      assertTaskAssignable(task.status);
      const membership = await repo.findActiveMembershipById(
        em,
        context.tenantId,
        input.membership_id,
      );
      if (!membership) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      const nextStatus: TaskStatus =
        task.status === 'PENDING' ? 'ASSIGNED' : task.status;
      const row = await resolveTaskWrite(
        em,
        context.tenantId,
        propertyId,
        taskId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyTaskTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            taskId,
            expectedVersion: input.version,
            status: nextStatus,
            setAssignee: true,
            assigneeMembershipId: membership.id,
          }),
        ),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.task_assigned',
        resourceType: 'OpsTask',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          status: task.status,
          assignee_membership_id: task.assignee_membership_id,
        },
        afterSafe: {
          status: row.status,
          assignee_membership_id: row.assignee_membership_id,
        },
        correlationId: context.correlationId,
      });
      const response = { task: taskView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'AssignTask',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

async function loadOwnedTask(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  taskId: string,
): Promise<{ task: repo.OpsTaskRow; membershipId: string | null }> {
  const task = await requireTask(em, context.tenantId, propertyId, taskId);
  const membershipId = await actorMembershipId(em, context);
  if (!membershipId || task.assignee_membership_id !== membershipId)
    throw new PropertyError('TASK_NOT_ASSIGNED', {
      task_id: task.id,
      assignee_membership_id: task.assignee_membership_id,
    });
  return { task, membershipId };
}

export async function startTask(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  taskId: string,
  input: { version: number; idempotencyKey?: string | null },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'StartTask',
    task_id: taskId,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.complete', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'StartTask',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const { task } = await loadOwnedTask(em, context, propertyId, taskId);
      assertTaskTransition(task.status, 'IN_PROGRESS');
      const row = await resolveTaskWrite(
        em,
        context.tenantId,
        propertyId,
        taskId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyTaskTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            taskId,
            expectedVersion: input.version,
            status: 'IN_PROGRESS',
            cleanStartedAt: new Date().toISOString(),
          }),
        ),
      );
      if (row.resource_id)
        await translatePropertyWrite(() =>
          updateResourceHousekeeping(em, {
            tenantId: context.tenantId,
            propertyId,
            resourceId: row.resource_id as string,
            housekeepingState: 'CLEANING',
          }),
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.task_started',
        resourceType: 'OpsTask',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: task.status },
        afterSafe: {
          state: row.status,
          resource_id: row.resource_id,
          housekeeping_state: row.resource_id ? 'CLEANING' : null,
        },
        correlationId: context.correlationId,
      });
      const response = { task: taskView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'StartTask',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function completeTask(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  taskId: string,
  input: TaskCommandInput,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const note = input.note ? assertSafeText(input.note, 'note', 500) : null;
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CompleteTask',
    task_id: taskId,
    version: input.version,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.complete', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CompleteTask',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const { task } = await loadOwnedTask(em, context, propertyId, taskId);
      assertTaskTransition(task.status, 'CLEAN');
      const row = await resolveTaskWrite(
        em,
        context.tenantId,
        propertyId,
        taskId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyTaskTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            taskId,
            expectedVersion: input.version,
            status: 'CLEAN',
            cleanCompletedAt: new Date().toISOString(),
          }),
        ),
      );
      if (row.resource_id)
        await translatePropertyWrite(() =>
          updateResourceHousekeeping(em, {
            tenantId: context.tenantId,
            propertyId,
            resourceId: row.resource_id as string,
            housekeepingState: 'CLEAN',
          }),
        );
      const policy = await repo.findOperationsPolicy(
        em,
        context.tenantId,
        propertyId,
      );
      if (policy?.inspection_required === true)
        await translatePropertyWrite(() =>
          emitNotification(em, {
            tenantId: context.tenantId,
            propertyId,
            type: 'TASK_READY_FOR_INSPECTION',
            severity: 'WARNING',
            title: 'Housekeeping task awaiting inspection',
            body: row.description ?? `Task ${row.id}`,
            resourceType: 'OpsTask',
            resourceId: row.id,
          }),
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.task_completed',
        resourceType: 'OpsTask',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: task.status },
        afterSafe: {
          state: row.status,
          resource_id: row.resource_id,
          housekeeping_state: row.resource_id ? 'CLEAN' : null,
          note,
        },
        correlationId: context.correlationId,
      });
      const response = { task: taskView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CompleteTask',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function inspectTask(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  taskId: string,
  input: TaskCommandInput,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const note = input.note ? assertSafeText(input.note, 'note', 500) : null;
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'InspectTask',
    task_id: taskId,
    version: input.version,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.inspect', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'InspectTask',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const task = await requireTask(em, context.tenantId, propertyId, taskId);
      assertTaskTransition(task.status, 'INSPECTED');
      const inspector = await actorMembershipId(em, context);
      const policy = await repo.findOperationsPolicy(
        em,
        context.tenantId,
        propertyId,
      );
      if (
        policy?.inspection_required === true &&
        inspector !== null &&
        task.assignee_membership_id === inspector
      )
        throw new PropertyError('SELF_INSPECTION_DENIED');
      const row = await resolveTaskWrite(
        em,
        context.tenantId,
        propertyId,
        taskId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyTaskTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            taskId,
            expectedVersion: input.version,
            status: 'INSPECTED',
            inspectedAt: new Date().toISOString(),
            inspectedByMembershipId: inspector,
          }),
        ),
      );
      if (row.resource_id)
        await translatePropertyWrite(() =>
          updateResourceHousekeeping(em, {
            tenantId: context.tenantId,
            propertyId,
            resourceId: row.resource_id as string,
            housekeepingState: 'INSPECTED',
          }),
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.task_inspected',
        resourceType: 'OpsTask',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: task.status },
        afterSafe: {
          state: row.status,
          resource_id: row.resource_id,
          housekeeping_state: row.resource_id ? 'INSPECTED' : null,
          note,
        },
        correlationId: context.correlationId,
      });
      const response = { task: taskView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'InspectTask',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function logDnd(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: LogDndInput,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const note = assertSafeText(input.note, 'note', 500);
  const requestHash = hashRequest({
    operation: 'LogDnd',
    resource_id: input.resource_id,
    item_id: input.item_id ?? null,
    note,
    follow_up_at: input.follow_up_at ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'LogDnd',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const resource = await findResource(
        em,
        context.tenantId,
        propertyId,
        input.resource_id,
      );
      if (!resource) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      let itemId: string | null = null;
      if (input.item_id) {
        const item = await findReservationItem(
          em,
          context.tenantId,
          propertyId,
          input.item_id,
        );
        if (!item) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        itemId = item.id;
      }
      let followUpAt: string | null = null;
      if (input.follow_up_at) {
        const parsed = new Date(input.follow_up_at);
        if (Number.isNaN(parsed.getTime()))
          throw new PropertyError('INVALID_REQUEST', { field: 'follow_up_at' });
        followUpAt = parsed.toISOString();
      }
      const createdByMembershipId = await actorMembershipId(em, context);
      const row = await translatePropertyWrite(() =>
        repo.insertDndLog(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceId: resource.id,
          itemId,
          note,
          followUpAt,
          createdByMembershipId,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.dnd_logged',
        resourceType: 'OpsDndLog',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          resource_id: row.resource_id,
          item_id: row.item_id,
          state: row.state,
          follow_up_at: row.follow_up_at,
          housekeeping_state: resource.housekeeping_state,
        },
        correlationId: context.correlationId,
      });
      const response = { dnd: dndView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'LogDnd',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function followUpDnd(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  dndId: string,
  input: FollowUpDndInput,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const note = assertSafeText(input.note, 'note', 500);
  const requestHash = hashRequest({
    operation: 'FollowUpDnd',
    dnd_id: dndId,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.complete', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'FollowUpDnd',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const dnd = await repo.findDndLog(
        em,
        context.tenantId,
        propertyId,
        dndId,
      );
      if (!dnd) throw new PropertyError('NOT_FOUND');
      if (dnd.state !== 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: dnd.state,
          to: 'FOLLOWED_UP',
        });
      const followedUp = await translatePropertyWrite(() =>
        repo.markDndFollowedUp(em, {
          tenantId: context.tenantId,
          propertyId,
          dndId,
          attemptAt: new Date().toISOString(),
          note,
        }),
      );
      if (!followedUp)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: 'ACTIVE',
          to: 'FOLLOWED_UP',
        });
      const row = followedUp;
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.dnd_followed_up',
        resourceType: 'OpsDndLog',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: dnd.state },
        afterSafe: { state: row.state, note },
        correlationId: context.correlationId,
      });
      const response = { dnd: dndView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'FollowUpDnd',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function listDndLogs(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    resource_id?: string | null;
    state?: string | null;
    limit?: number;
    cursor?: string | null;
  },
): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  if (input.state && !['ACTIVE', 'FOLLOWED_UP'].includes(input.state))
    throw new PropertyError('INVALID_REQUEST', { field: 'state' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const logs = await repo.listDndLogRows(em, context.tenantId, propertyId, {
        resourceId: input.resource_id ?? null,
        state: input.state ?? null,
        limit,
        cursor: input.cursor ?? null,
      });
      return {
        dnd_logs: logs.map(dndView),
        next_cursor:
          logs.length === limit
            ? `${logs[logs.length - 1]?.created_at}|${logs[logs.length - 1]?.id}`
            : null,
      };
    },
  );
}

export async function setOperationsPolicy(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: SetOperationsPolicyInput,
): Promise<Record<string, unknown>> {
  const interval = input.long_stay_clean_interval_days ?? null;
  if (
    interval !== null &&
    (!Number.isInteger(interval) || interval < 1 || interval > 365)
  )
    throw new PropertyError('INVALID_REQUEST', {
      field: 'long_stay_clean_interval_days',
    });
  if (typeof input.inspection_required !== 'boolean')
    throw new PropertyError('INVALID_REQUEST', {
      field: 'inspection_required',
    });
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'SetOperationsPolicy',
    inspection_required: input.inspection_required,
    long_stay_clean_interval_days: interval,
    version: input.version ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'SetOperationsPolicy',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const existing = await repo.findOperationsPolicy(
        em,
        context.tenantId,
        propertyId,
      );
      let row: repo.OperationsPolicyRow;
      if (!existing) {
        row = await translatePropertyWrite(() =>
          repo.insertOperationsPolicy(em, {
            tenantId: context.tenantId,
            propertyId,
            inspectionRequired: input.inspection_required,
            longStayCleanIntervalDays: interval,
          }),
        );
      } else {
        if (
          !Number.isInteger(input.version) ||
          input.version !== existing.version
        )
          throw new PropertyError('STALE_VERSION', {
            expected: input.version ?? null,
            current: existing.version,
          });
        const updated = await translatePropertyWrite(() =>
          repo.updateOperationsPolicy(em, {
            tenantId: context.tenantId,
            propertyId,
            version: existing.version,
            inspectionRequired: input.inspection_required,
            longStayCleanIntervalDays: interval,
          }),
        );
        if (!updated)
          throw new PropertyError('STALE_VERSION', {
            expected: input.version,
            current: existing.version,
          });
        row = updated;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.policy_updated',
        resourceType: 'PropertyOperationsPolicy',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: existing
          ? {
              inspection_required: existing.inspection_required,
              long_stay_clean_interval_days:
                existing.long_stay_clean_interval_days,
              version: existing.version,
            }
          : null,
        afterSafe: {
          inspection_required: row.inspection_required,
          long_stay_clean_interval_days: row.long_stay_clean_interval_days,
          version: row.version,
        },
        correlationId: context.correlationId,
      });
      const response = { policy: policyView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'SetOperationsPolicy',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function getOperationsPolicy(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const row = await repo.findOperationsPolicy(
        em,
        context.tenantId,
        propertyId,
      );
      return { policy: policyView(row) };
    },
  );
}

function prepTaskResource(event: StayPrepEventInput): string | null {
  const payload = event.payload ?? {};
  if (event.type === 'STAY_CHECKED_OUT')
    return (payload.resource_id as string | undefined) ?? event.resource_id;
  return (payload.from_resource_id as string | undefined) ?? null;
}

function prepTaskDueDate(event: StayPrepEventInput): string | null {
  const payload = event.payload ?? {};
  if (event.type === 'STAY_CHECKED_OUT')
    return (payload.business_date as string | undefined) ?? null;
  return (payload.effective_date as string | undefined) ?? null;
}

export async function createPrepTaskForStayEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    event: StayPrepEventInput;
    vacate: boolean;
    correlationId?: string | null;
  },
): Promise<{
  inserted: boolean;
  row: repo.OpsTaskRow | null;
  insertedRows: repo.OpsTaskRow[];
}> {
  const payloadResources = input.event.payload?.resource_ids;
  const resources =
    input.event.type === 'STAY_CHECKED_OUT' &&
    Array.isArray(payloadResources) &&
    payloadResources.length > 0
      ? [...new Set(payloadResources)]
      : [prepTaskResource(input.event)];
  const insertedRows: repo.OpsTaskRow[] = [];
  let firstRow: repo.OpsTaskRow | null = null;
  for (const resourceId of resources) {
    if (resourceId === null) continue;
    if (typeof resourceId !== 'string')
      throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
    const result = await repo.insertPrepTask(em, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      sourceEventId: input.event.id,
      sourceEventType: input.event.type,
      resourceId,
      itemId: input.event.item_id,
      reservationId: input.event.reservation_id,
      dueDate: prepTaskDueDate(input.event),
    });
    if (result.inserted && result.row)
      await recordAudit(em, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        actorType: 'SERVICE',
        actorId: null,
        actorLabel: 'stay-event-intake',
        action: 'ops.task_created',
        resourceType: 'OpsTask',
        resourceId: result.row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          source_event_id: input.event.id,
          source_event_type: input.event.type,
          resource_id: resourceId,
          item_id: input.event.item_id,
          priority: result.row.priority,
          due_date: result.row.due_date,
        },
        correlationId: input.correlationId ?? null,
      });
    if (input.vacate && result.row)
      await updateResourceHousekeeping(em, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        resourceId,
        housekeepingState: 'DIRTY',
      });
    firstRow ??= result.row;
    if (result.inserted) insertedRows.push(result.row);
  }
  return { inserted: insertedRows.length > 0, row: firstRow, insertedRows };
}

export async function runOperationsIntake(
  orm: MikroORM,
  input: { tenantId: string; propertyId: string },
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: input.tenantId, userId: null },
    async (em) => {
      const events = await repo.listUnconsumedStayPrepEvents(
        em,
        input.tenantId,
        input.propertyId,
      );
      const taskIds: string[] = [];
      for (const event of events) {
        const result = await translatePropertyWrite(() =>
          createPrepTaskForStayEvent(em, {
            tenantId: input.tenantId,
            propertyId: input.propertyId,
            event,
            vacate: false,
          }),
        );
        taskIds.push(...result.insertedRows.map((row) => row.id));
      }
      return {
        processed: events.length,
        created: taskIds.length,
        task_ids: taskIds,
      };
    },
  );
}
