import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import { PropertyError } from '../../property/domain/errors.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  findResource,
  updateResourceMaintenance,
} from '../../property/persistence/resource-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import {
  createEmergencyMaintenanceBlock,
  resolveBlockDisruptions,
} from '../../inventory/application/block-service.js';
import {
  assertWorkOrderTransition,
  isWorkOrderCategory,
  isWorkOrderImpact,
  isWorkOrderSeverity,
  isWorkOrderStatus,
  maxImpact,
} from '../domain/work-order-state.js';
import type {
  WorkOrderCategory,
  WorkOrderImpact,
  WorkOrderSeverity,
  WorkOrderStatus,
} from '../domain/work-order-state.js';
import * as repo from '../persistence/operations-repository.js';
import { emitNotification } from './shift-handover-service.js';

export interface CreateWorkOrderInput {
  resource_id: string;
  category: string;
  severity: string;
  impact: string;
  emergency: boolean;
  description: string;
  period?: { arrival: string; departure: string } | null;
  assignee_membership_id?: string | null;
  idempotencyKey?: string | null;
}

export interface ListWorkOrdersInput {
  status?: string | null;
  resource_id?: string | null;
  assignee_membership_id?: string | null;
  limit?: number;
  cursor?: string | null;
}

function workOrderView(row: repo.WorkOrderRow) {
  return {
    id: row.id,
    resource_id: row.resource_id,
    resource_code: row.resource_code ?? null,
    resource_display_label: row.resource_display_label ?? null,
    resource_location_path: row.resource_location_path ?? [],
    category: row.category,
    severity: row.severity,
    impact: row.impact,
    emergency: row.emergency,
    status: row.status,
    description: row.description,
    period_start: row.period_start,
    period_end: row.period_end,
    block_id: row.block_id,
    assignee_membership_id: row.assignee_membership_id,
    resolution_note: row.resolution_note,
    verified_at: row.verified_at,
    verified_by_membership_id: row.verified_by_membership_id,
    closed_at: row.closed_at,
    reopen_count: row.reopen_count,
    last_reopen_reason: row.last_reopen_reason,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
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

async function requireWorkOrder(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  workOrderId: string,
): Promise<repo.WorkOrderRow> {
  const row = await repo.findWorkOrder(em, tenantId, propertyId, workOrderId);
  if (!row) throw new PropertyError('NOT_FOUND');
  return row;
}

async function resolveWorkOrderWrite(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  workOrderId: string,
  expectedVersion: number,
  row: repo.WorkOrderRow | null,
): Promise<repo.WorkOrderRow> {
  if (row) return row;
  const fresh = await repo.findWorkOrder(em, tenantId, propertyId, workOrderId);
  if (!fresh) throw new PropertyError('NOT_FOUND');
  if (fresh.version !== expectedVersion)
    throw new PropertyError('STALE_VERSION', {
      expected: expectedVersion,
      current: fresh.version,
    });
  throw new PropertyError('INVALID_STATE_TRANSITION', { state: fresh.status });
}

async function recomputeMaintenance(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  resourceId: string,
): Promise<WorkOrderImpact> {
  const impacts = await repo.listOpenWorkOrderImpacts(
    em,
    context.tenantId,
    propertyId,
    resourceId,
  );
  const next = maxImpact(impacts);
  const resource = await findResource(
    em,
    context.tenantId,
    propertyId,
    resourceId,
  );
  if (!resource) throw new PropertyError('NOT_FOUND');
  if (resource.maintenance_state !== next)
    await translatePropertyWrite(() =>
      updateResourceMaintenance(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceId,
        version: resource.version,
        maintenanceState: next,
      }),
    );
  return next;
}

export async function createWorkOrder(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: CreateWorkOrderInput,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CreateWorkOrder',
    resource_id: input.resource_id,
    category: input.category,
    severity: input.severity,
    impact: input.impact,
    emergency: input.emergency,
    period: input.period ?? null,
    assignee_membership_id: input.assignee_membership_id ?? null,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.manage', propertyId);
      if (input.emergency)
        await authorize(em, context, 'maintenance.emergency', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CreateWorkOrder',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      if (!isWorkOrderCategory(input.category))
        throw new PropertyError('INVALID_REQUEST', { field: 'category' });
      const category: WorkOrderCategory = input.category;
      if (!isWorkOrderSeverity(input.severity))
        throw new PropertyError('INVALID_REQUEST', { field: 'severity' });
      const severity: WorkOrderSeverity = input.severity;
      if (!isWorkOrderImpact(input.impact))
        throw new PropertyError('INVALID_REQUEST', { field: 'impact' });
      const impact: WorkOrderImpact = input.impact;
      const description = assertSafeText(
        input.description,
        'description',
        1000,
      );
      if (input.emergency && impact !== 'OOO')
        throw new PropertyError('INVALID_REQUEST', {
          field: 'impact',
          reason: 'emergency_requires_ooo',
        });
      let periodStart: string | null = null;
      let periodEnd: string | null = null;
      if (input.period) {
        periodStart = assertIsoDate(input.period.arrival, 'period.arrival');
        periodEnd = assertIsoDate(input.period.departure, 'period.departure');
        if (periodEnd <= periodStart)
          throw new PropertyError('INVALID_REQUEST', { field: 'period' });
      }
      if (input.emergency && (!periodStart || !periodEnd))
        throw new PropertyError('INVALID_REQUEST', { field: 'period' });
      const resource = await findResource(
        em,
        context.tenantId,
        propertyId,
        input.resource_id,
      );
      if (!resource) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (resource.state === 'RETIRED')
        throw new PropertyError('RESOURCE_RETIRED');
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
      let blockId: string | null = null;
      if (input.emergency) {
        const block = await translatePropertyWrite(() =>
          createEmergencyMaintenanceBlock(em, {
            tenantId: context.tenantId,
            propertyId,
            resourceId: resource.id,
            startDate: periodStart as string,
            endDate: periodEnd as string,
            reason: description,
            actor: {
              kind: context.actor.kind,
              id: context.actor.userId,
              label: context.actor.displayName,
            },
            correlationId: context.correlationId,
          }),
        );
        blockId = block.block.id;
      }
      const createdByMembershipId = await actorMembershipId(em, context);
      const row = await translatePropertyWrite(() =>
        repo.insertWorkOrder(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceId: resource.id,
          category,
          severity,
          impact,
          emergency: input.emergency,
          description,
          periodStart,
          periodEnd,
          blockId,
          assigneeMembershipId: assignee,
          createdByMembershipId,
        }),
      );
      const maintenanceState =
        impact === 'NONE'
          ? resource.maintenance_state
          : await recomputeMaintenance(em, context, propertyId, resource.id);
      if (row.emergency)
        await translatePropertyWrite(() =>
          emitNotification(em, {
            tenantId: context.tenantId,
            propertyId,
            type: 'WORK_ORDER_EMERGENCY',
            severity: 'CRITICAL',
            title: `Emergency maintenance on ${resource.code}`,
            body: row.description,
            resourceType: 'OpsWorkOrder',
            resourceId: row.id,
          }),
        );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.work_order_created',
        resourceType: 'OpsWorkOrder',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          resource_id: row.resource_id,
          category: row.category,
          severity: row.severity,
          impact: row.impact,
          emergency: row.emergency,
          status: row.status,
          block_id: row.block_id,
          maintenance_state: maintenanceState,
        },
        correlationId: context.correlationId,
      });
      const response = { work_order: workOrderView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CreateWorkOrder',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function listWorkOrders(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ListWorkOrdersInput,
): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  if (input.status && !isWorkOrderStatus(input.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.read', propertyId);
      const orders = await repo.listWorkOrderRows(
        em,
        context.tenantId,
        propertyId,
        {
          status: input.status ?? null,
          resourceId: input.resource_id ?? null,
          assigneeMembershipId: input.assignee_membership_id ?? null,
          limit,
          cursor: input.cursor ?? null,
        },
      );
      return {
        work_orders: orders.map(workOrderView),
        next_cursor:
          orders.length === limit
            ? `${orders[orders.length - 1]?.created_at}|${orders[orders.length - 1]?.id}`
            : null,
      };
    },
  );
}

export async function assignWorkOrder(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  workOrderId: string,
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
    operation: 'AssignWorkOrder',
    work_order_id: workOrderId,
    membership_id: input.membership_id,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'AssignWorkOrder',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const order = await requireWorkOrder(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
      );
      if (
        !['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS'].includes(order.status)
      )
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: order.status,
          to: 'ASSIGNED',
        });
      const membership = await repo.findActiveMembershipById(
        em,
        context.tenantId,
        input.membership_id,
      );
      if (!membership) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      const nextStatus: WorkOrderStatus =
        order.status === 'OPEN' || order.status === 'TRIAGED'
          ? 'ASSIGNED'
          : (order.status as WorkOrderStatus);
      const row = await resolveWorkOrderWrite(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyWorkOrderTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            workOrderId,
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
        action: 'ops.work_order_assigned',
        resourceType: 'OpsWorkOrder',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          status: order.status,
          assignee_membership_id: order.assignee_membership_id,
        },
        afterSafe: {
          status: row.status,
          assignee_membership_id: row.assignee_membership_id,
        },
        correlationId: context.correlationId,
      });
      const response = { work_order: workOrderView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'AssignWorkOrder',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function transitionWorkOrder(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  workOrderId: string,
  input: {
    status: string;
    version: number;
    note?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (!isWorkOrderStatus(input.status) || input.status === 'CLOSED')
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  const status: WorkOrderStatus = input.status;
  const note = input.note ? assertSafeText(input.note, 'note', 500) : null;
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'TransitionWorkOrder',
    work_order_id: workOrderId,
    status,
    version: input.version,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'TransitionWorkOrder',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const order = await requireWorkOrder(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
      );
      assertWorkOrderTransition(order.status as WorkOrderStatus, status);
      if (status === 'RESOLVED' && !note)
        throw new PropertyError('INVALID_REQUEST', { field: 'note' });
      const actor = await actorMembershipId(em, context);
      const row = await resolveWorkOrderWrite(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyWorkOrderTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            workOrderId,
            expectedVersion: input.version,
            status,
            resolutionNote: status === 'RESOLVED' ? note : null,
            verifiedAt: status === 'VERIFIED' ? new Date().toISOString() : null,
            verifiedByMembershipId: status === 'VERIFIED' ? actor : null,
          }),
        ),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.work_order_transitioned',
        resourceType: 'OpsWorkOrder',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: order.status },
        afterSafe: { status: row.status, note },
        correlationId: context.correlationId,
      });
      const response = { work_order: workOrderView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'TransitionWorkOrder',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function closeWorkOrder(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  workOrderId: string,
  input: {
    version: number;
    note?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const note = input.note ? assertSafeText(input.note, 'note', 500) : null;
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CloseWorkOrder',
    work_order_id: workOrderId,
    version: input.version,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CloseWorkOrder',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const order = await requireWorkOrder(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
      );
      assertWorkOrderTransition(order.status as WorkOrderStatus, 'CLOSED');
      const row = await resolveWorkOrderWrite(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyWorkOrderTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            workOrderId,
            expectedVersion: input.version,
            status: 'CLOSED',
            closedAt: new Date().toISOString(),
            resolutionNote: note,
          }),
        ),
      );
      const maintenanceState = await recomputeMaintenance(
        em,
        context,
        propertyId,
        row.resource_id,
      );
      let resolvedDisruptions = 0;
      if (row.block_id) {
        const resolved = await translatePropertyWrite(() =>
          resolveBlockDisruptions(em, {
            tenantId: context.tenantId,
            propertyId,
            blockId: row.block_id as string,
            note: note ?? row.description,
          }),
        );
        resolvedDisruptions = resolved.length;
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.work_order_closed',
        resourceType: 'OpsWorkOrder',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: order.status },
        afterSafe: {
          status: row.status,
          maintenance_state: maintenanceState,
          block_id: row.block_id,
          resolved_disruptions: resolvedDisruptions,
        },
        correlationId: context.correlationId,
      });
      const response = { work_order: workOrderView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CloseWorkOrder',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function reopenWorkOrder(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  workOrderId: string,
  input: {
    reason: string;
    version: number;
    idempotencyKey?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const reason = assertSafeText(input.reason, 'reason', 500);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ReopenWorkOrder',
    work_order_id: workOrderId,
    reason,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'maintenance.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'ReopenWorkOrder',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const order = await requireWorkOrder(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
      );
      if (order.status !== 'CLOSED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: order.status,
          to: 'OPEN',
        });
      const row = await resolveWorkOrderWrite(
        em,
        context.tenantId,
        propertyId,
        workOrderId,
        input.version,
        await translatePropertyWrite(() =>
          repo.applyWorkOrderTransition(em, {
            tenantId: context.tenantId,
            propertyId,
            workOrderId,
            expectedVersion: input.version,
            status: 'OPEN',
            clearClosedAt: true,
            reopenCount: order.reopen_count + 1,
            lastReopenReason: reason,
          }),
        ),
      );
      const maintenanceState = await recomputeMaintenance(
        em,
        context,
        propertyId,
        row.resource_id,
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.work_order_reopened',
        resourceType: 'OpsWorkOrder',
        resourceId: row.id,
        outcome: 'SUCCESS',
        beforeSafe: { status: order.status },
        afterSafe: {
          status: row.status,
          reason,
          reopen_count: row.reopen_count,
          maintenance_state: maintenanceState,
        },
        correlationId: context.correlationId,
      });
      const response = { work_order: workOrderView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ReopenWorkOrder',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}
