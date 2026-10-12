import { api } from './client.js';

export type TaskStatus =
  'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'CLEAN' | 'INSPECTED' | 'CANCELLED';

export interface OpsTask {
  id: string;
  type: 'HOUSEKEEPING' | 'GUEST_REQUEST';
  status: TaskStatus;
  resource_id: string | null;
  resource_code: string | null;
  resource_display_label?: string | null;
  resource_location_path?: string[];
  item_id: string | null;
  reservation_id: string | null;
  description: string | null;
  priority: number;
  due_date: string | null;
  policy_version: number | null;
  assignee_membership_id: string | null;
  source_event_id: string | null;
  source_event_type: string | null;
  clean_started_at: string | null;
  clean_completed_at: string | null;
  inspected_at: string | null;
  inspected_by_membership_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DndLog {
  id: string;
  resource_id: string;
  item_id: string | null;
  state: 'ACTIVE' | 'FOLLOWED_UP';
  note: string;
  follow_up_at: string | null;
  follow_up_note: string | null;
  follow_up_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkOrderStatus =
  | 'OPEN'
  | 'TRIAGED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'VERIFIED'
  | 'CLOSED';

export interface WorkOrder {
  id: string;
  resource_id: string;
  resource_code: string | null;
  resource_display_label?: string | null;
  resource_location_path?: string[];
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  impact: 'NONE' | 'OOS' | 'OOO';
  emergency: boolean;
  status: WorkOrderStatus;
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
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ShiftHandover {
  id: string;
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

export interface OpsNotification {
  id: string;
  type: 'WORK_ORDER_EMERGENCY' | 'TASK_READY_FOR_INSPECTION' | 'SHIFT_HANDOVER';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  recipient_membership_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface OperationsPolicy {
  configured: boolean;
  inspection_required: boolean;
  long_stay_clean_interval_days: number | null;
  version: number | null;
}

export interface OperationsBoard {
  date: string;
  timezone: string;
  inspection_required: boolean;
  buckets: {
    pending: number;
    assigned: number;
    in_progress: number;
    awaiting_inspection: number;
    ready: number;
  };
  tasks: OpsTask[];
  dnd_logs: DndLog[];
  notifications: OpsNotification[];
  unread_notifications: number;
}

export interface TaskResult {
  task: OpsTask;
  replayed: boolean;
}

function tenantRoot(tenantId: string, propertyId: string) {
  return `/api/v1/tenants/${tenantId}/properties/${propertyId}`;
}

function write(path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST') {
  return api<Record<string, unknown>>(path, {
    method,
    ...(body === undefined ? {} : { body }),
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
}

export const operationsApi = {
  getBoard: (tenantId: string, propertyId: string) =>
    api<OperationsBoard>(
      `${tenantRoot(tenantId, propertyId)}/operations/board`,
    ),
  getPolicy: (tenantId: string, propertyId: string) =>
    api<{ policy: OperationsPolicy }>(
      `${tenantRoot(tenantId, propertyId)}/operations-policy`,
    ),
  setPolicy: (
    tenantId: string,
    propertyId: string,
    body: {
      inspection_required: boolean;
      long_stay_clean_interval_days: number | null;
      version?: number;
    },
  ) =>
    write(`${tenantRoot(tenantId, propertyId)}/operations-policy`, body, 'PUT'),
  assignTask: (
    tenantId: string,
    propertyId: string,
    taskId: string,
    body: { membership_id: string; version: number },
  ) =>
    write(`${tenantRoot(tenantId, propertyId)}/tasks/${taskId}/assign`, body),
  startTask: (
    tenantId: string,
    propertyId: string,
    taskId: string,
    body: { version: number },
  ) => write(`${tenantRoot(tenantId, propertyId)}/tasks/${taskId}/start`, body),
  completeTask: (
    tenantId: string,
    propertyId: string,
    taskId: string,
    body: { version: number; note?: string },
  ) =>
    write(`${tenantRoot(tenantId, propertyId)}/tasks/${taskId}/complete`, body),
  inspectTask: (
    tenantId: string,
    propertyId: string,
    taskId: string,
    body: { version: number; note?: string },
  ) =>
    write(`${tenantRoot(tenantId, propertyId)}/tasks/${taskId}/inspect`, body),
  logDnd: (
    tenantId: string,
    propertyId: string,
    body: {
      resource_id: string;
      item_id?: string;
      note: string;
      follow_up_at?: string;
    },
  ) => write(`${tenantRoot(tenantId, propertyId)}/dnd-logs`, body),
  followUpDnd: (
    tenantId: string,
    propertyId: string,
    dndId: string,
    body: { note: string },
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/dnd-logs/${dndId}/follow-up`,
      body,
    ),
  listWorkOrders: (tenantId: string, propertyId: string) =>
    api<{ work_orders: WorkOrder[] }>(
      `${tenantRoot(tenantId, propertyId)}/work-orders`,
    ),
  createWorkOrder: (
    tenantId: string,
    propertyId: string,
    body: {
      resource_id: string;
      category: string;
      severity: string;
      impact: string;
      emergency?: boolean;
      description: string;
      period?: { arrival: string; departure: string };
      assignee_membership_id?: string;
    },
  ) => write(`${tenantRoot(tenantId, propertyId)}/work-orders`, body),
  assignWorkOrder: (
    tenantId: string,
    propertyId: string,
    workOrderId: string,
    body: { membership_id: string; version: number },
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/work-orders/${workOrderId}/assign`,
      body,
    ),
  transitionWorkOrder: (
    tenantId: string,
    propertyId: string,
    workOrderId: string,
    body: { status: string; version: number; note?: string },
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/work-orders/${workOrderId}/transitions`,
      body,
    ),
  closeWorkOrder: (
    tenantId: string,
    propertyId: string,
    workOrderId: string,
    body: { version: number; note?: string },
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/work-orders/${workOrderId}/close`,
      body,
    ),
  reopenWorkOrder: (
    tenantId: string,
    propertyId: string,
    workOrderId: string,
    body: { reason: string; version: number },
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/work-orders/${workOrderId}/reopen`,
      body,
    ),
  listHandovers: (tenantId: string, propertyId: string) =>
    api<{ handovers: ShiftHandover[] }>(
      `${tenantRoot(tenantId, propertyId)}/shift-handovers`,
    ),
  createHandover: (
    tenantId: string,
    propertyId: string,
    body: {
      shift_date?: string;
      to_membership_id?: string;
      follow_up_membership_id?: string;
      cashier_session_id?: string;
      exceptions_text?: string;
      note?: string;
    },
  ) => write(`${tenantRoot(tenantId, propertyId)}/shift-handovers`, body),
  listNotifications: (tenantId: string, propertyId: string) =>
    api<{ notifications: OpsNotification[]; unread: number }>(
      `${tenantRoot(tenantId, propertyId)}/notifications`,
    ),
  markNotificationRead: (
    tenantId: string,
    propertyId: string,
    notificationId: string,
  ) =>
    write(
      `${tenantRoot(tenantId, propertyId)}/notifications/${notificationId}/read`,
    ),
};
