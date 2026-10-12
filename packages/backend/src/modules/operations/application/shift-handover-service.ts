import type { MikroORM } from '@mikro-orm/postgresql';
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
import { findCashierSession } from '../../finance/persistence/billing-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import * as repo from '../persistence/operations-repository.js';
import { businessToday } from '../../front-office/application/front-office-service.js';

export interface CreateShiftHandoverInput {
  shift_date?: string | null;
  to_membership_id?: string | null;
  follow_up_membership_id?: string | null;
  cashier_session_id?: string | null;
  exceptions_text?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
}

function handoverView(row: repo.ShiftHandoverRow) {
  return {
    id: row.id,
    shift_date: row.shift_date,
    from_membership_id: row.from_membership_id,
    to_membership_id: row.to_membership_id,
    follow_up_membership_id: row.follow_up_membership_id,
    open_tasks: row.open_tasks,
    open_work_orders: row.open_work_orders,
    active_dnd: row.active_dnd,
    cashier_session_id: row.cashier_session_id,
    cashier_currency: row.cashier_currency,
    cashier_expected_amount: row.cashier_expected_amount,
    cashier_counted_amount: row.cashier_counted_amount,
    cashier_variance: row.cashier_variance,
    exceptions_text: row.exceptions_text,
    note: row.note,
    created_by_membership_id: row.created_by_membership_id,
    created_at: row.created_at,
  };
}

export function notificationView(row: repo.NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    recipient_membership_id: row.recipient_membership_id,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

export async function emitNotification(
  em: Parameters<typeof repo.insertNotification>[0],
  input: {
    tenantId: string;
    propertyId: string;
    type: string;
    severity: string;
    title: string;
    body?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    recipientMembershipId?: string | null;
  },
): Promise<repo.NotificationRow> {
  return repo.insertNotification(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    type: input.type,
    severity: input.severity,
    title: input.title,
    body: input.body ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    recipientMembershipId: input.recipientMembershipId ?? null,
  });
}

async function actorMembershipId(
  em: Parameters<typeof repo.findActiveMembership>[0],
  context: ServiceContext,
): Promise<string | null> {
  const membership = await repo.findActiveMembership(
    em,
    context.tenantId,
    context.actor.userId,
  );
  return membership?.id ?? null;
}

export async function createShiftHandover(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: CreateShiftHandoverInput,
): Promise<Record<string, unknown>> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const exceptionsText = input.exceptions_text
    ? assertSafeText(input.exceptions_text, 'exceptions_text', 1000)
    : null;
  const note = input.note ? assertSafeText(input.note, 'note', 1000) : null;
  const requestHash = hashRequest({
    operation: 'CreateShiftHandover',
    shift_date: input.shift_date ?? null,
    to_membership_id: input.to_membership_id ?? null,
    follow_up_membership_id: input.follow_up_membership_id ?? null,
    cashier_session_id: input.cashier_session_id ?? null,
    exceptions_text: exceptionsText,
    note,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CreateShiftHandover',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const shiftDate = input.shift_date
        ? assertIsoDate(input.shift_date, 'shift_date')
        : businessToday(property.timezone);
      let toMembership: string | null = null;
      if (input.to_membership_id) {
        const membership = await repo.findActiveMembershipById(
          em,
          context.tenantId,
          input.to_membership_id,
        );
        if (!membership) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        toMembership = membership.id;
      }
      let followUp: string | null = null;
      if (input.follow_up_membership_id) {
        const membership = await repo.findActiveMembershipById(
          em,
          context.tenantId,
          input.follow_up_membership_id,
        );
        if (!membership) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        followUp = membership.id;
      }
      let cashierSessionId: string | null = null;
      let cashierCurrency: string | null = null;
      let cashierExpected: string | null = null;
      let cashierCounted: string | null = null;
      let cashierVariance: string | null = null;
      if (input.cashier_session_id) {
        const session = await findCashierSession(
          em,
          context.tenantId,
          propertyId,
          input.cashier_session_id,
        );
        if (!session) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        cashierSessionId = session.id;
        cashierCurrency = session.currency;
        cashierExpected = session.expected_amount;
        cashierCounted = session.counted_amount;
        cashierVariance = session.variance;
      }
      const [openTasks, openWorkOrders, activeDnd] = await Promise.all([
        repo.countOpenTasks(em, context.tenantId, propertyId),
        repo.countOpenWorkOrders(em, context.tenantId, propertyId),
        repo.countActiveDnd(em, context.tenantId, propertyId),
      ]);
      const fromMembership = await actorMembershipId(em, context);
      const row = await translatePropertyWrite(() =>
        repo.insertShiftHandover(em, {
          tenantId: context.tenantId,
          propertyId,
          shiftDate,
          fromMembershipId: fromMembership,
          toMembershipId: toMembership,
          followUpMembershipId: followUp,
          openTasks,
          openWorkOrders,
          activeDnd,
          cashierSessionId,
          cashierCurrency,
          cashierExpectedAmount: cashierExpected,
          cashierCountedAmount: cashierCounted,
          cashierVariance,
          exceptionsText,
          note,
          createdByMembershipId: fromMembership,
        }),
      );
      await translatePropertyWrite(() =>
        emitNotification(em, {
          tenantId: context.tenantId,
          propertyId,
          type: 'SHIFT_HANDOVER',
          severity: 'INFO',
          title: 'Shift handover recorded',
          body: `${row.open_tasks} open tasks, ${row.open_work_orders} open work orders, ${row.active_dnd} active DND`,
          resourceType: 'OpsShiftHandover',
          resourceId: row.id,
          recipientMembershipId: toMembership,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.shift_handover_created',
        resourceType: 'OpsShiftHandover',
        resourceId: row.id,
        outcome: 'SUCCESS',
        afterSafe: {
          shift_date: row.shift_date,
          open_tasks: row.open_tasks,
          open_work_orders: row.open_work_orders,
          active_dnd: row.active_dnd,
          cashier_session_id: row.cashier_session_id,
          cashier_currency: row.cashier_currency,
          cashier_variance: row.cashier_variance,
          to_membership_id: row.to_membership_id,
          follow_up_membership_id: row.follow_up_membership_id,
        },
        correlationId: context.correlationId,
      });
      const response = { handover: handoverView(row), replayed: false };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CreateShiftHandover',
        key,
        requestHash,
        response,
        resourceId: row.id,
      });
      return response;
    },
  );
}

export async function listShiftHandovers(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: { limit?: number },
): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const rows = await repo.listShiftHandoverRows(
        em,
        context.tenantId,
        propertyId,
        limit,
      );
      return { handovers: rows.map(handoverView) };
    },
  );
}

export async function getOperationsBoard(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const property = await repo.findPropertyScopeRow(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const membershipId = await actorMembershipId(em, context);
      const [tasks, dndLogs, policy, notifications] = await Promise.all([
        repo.listTaskRows(em, context.tenantId, propertyId, {
          limit: 100,
          cursor: null,
        }),
        repo.listDndLogRows(em, context.tenantId, propertyId, {
          limit: 50,
          cursor: null,
        }),
        repo.findOperationsPolicy(em, context.tenantId, propertyId),
        repo.listNotificationRows(
          em,
          context.tenantId,
          propertyId,
          membershipId,
          20,
        ),
      ]);
      const buckets = {
        pending: tasks.filter((row) => row.status === 'PENDING').length,
        assigned: tasks.filter((row) => row.status === 'ASSIGNED').length,
        in_progress: tasks.filter((row) => row.status === 'IN_PROGRESS').length,
        awaiting_inspection: tasks.filter((row) => row.status === 'CLEAN')
          .length,
        ready: tasks.filter((row) => row.status === 'INSPECTED').length,
      };
      return {
        date: businessToday(property.timezone),
        timezone: property.timezone,
        inspection_required: policy?.inspection_required === true,
        buckets,
        tasks,
        dnd_logs: dndLogs,
        notifications: notifications.map(notificationView),
        unread_notifications: notifications.filter(
          (row) => row.read_at === null,
        ).length,
      };
    },
  );
}

export async function listNotifications(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: { limit?: number },
): Promise<Record<string, unknown>> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'limit' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const membershipId = await actorMembershipId(em, context);
      const rows = await repo.listNotificationRows(
        em,
        context.tenantId,
        propertyId,
        membershipId,
        limit,
      );
      return {
        notifications: rows.map(notificationView),
        unread: rows.filter((row) => row.read_at === null).length,
      };
    },
  );
}

export async function markNotificationRead(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  notificationId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'task.read', propertyId);
      const membershipId = await actorMembershipId(em, context);
      if (!membershipId) throw new PropertyError('NOT_FOUND');
      const notification = await repo.findNotification(
        em,
        context.tenantId,
        propertyId,
        notificationId,
      );
      if (!notification) throw new PropertyError('NOT_FOUND');
      if (
        notification.recipient_membership_id !== null &&
        notification.recipient_membership_id !== membershipId
      )
        throw new PropertyError('CROSS_SCOPE_REFERENCE');
      const inserted = await repo.insertNotificationReceipt(em, {
        tenantId: context.tenantId,
        propertyId,
        notificationId,
        membershipId,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'ops.notification_read',
        resourceType: 'OpsNotification',
        resourceId: notificationId,
        outcome: 'SUCCESS',
        afterSafe: { newly_read: inserted, membership_id: membershipId },
        correlationId: context.correlationId,
      });
      return { read: true, newly_read: inserted };
    },
  );
}
