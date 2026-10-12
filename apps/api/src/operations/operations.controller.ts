import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  assignTask,
  assignWorkOrder,
  closeWorkOrder,
  completeTask,
  createShiftHandover,
  createTask,
  createWorkOrder,
  followUpDnd,
  getOperationsBoard,
  getOperationsPolicy,
  inspectTask,
  listDndLogs,
  listNotifications,
  listShiftHandovers,
  listTasks,
  listWorkOrders,
  logDnd,
  markNotificationRead,
  reopenWorkOrder,
  setOperationsPolicy,
  startTask,
  transitionWorkOrder,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import {
  assignTaskBody,
  assignWorkOrderBody,
  closeWorkOrderBody,
  createShiftHandoverBody,
  createTaskBody,
  createWorkOrderBody,
  followUpDndBody,
  listDndQuery,
  listLimitQuery,
  listTasksQuery,
  listWorkOrdersQuery,
  logDndBody,
  reopenWorkOrderBody,
  setOperationsPolicyBody,
  taskCommandBody,
  transitionWorkOrderBody,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1/tenants')
export class OperationsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/tasks')
  async listTasks(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listTasksQuery.parse(query);
    return listTasks(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        status: input.status ?? null,
        assignee_membership_id: input.assignee_membership_id ?? null,
        resource_id: input.resource_id ?? null,
        item_id: input.item_id ?? null,
        limit: input.limit,
        cursor: input.cursor ?? null,
      },
    );
  }

  @RequirePermission('task.manage')
  @Post(':tenantId/properties/:propertyId/tasks')
  async createTask(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = createTaskBody.parse(body);
    return createTask(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        type: input.type,
        description: input.description,
        resource_id: input.resource_id ?? null,
        item_id: input.item_id ?? null,
        assignee_membership_id: input.assignee_membership_id ?? null,
        priority: input.priority,
        due_date: input.due_date ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/tasks/:taskId/assign')
  async assignTask(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = assignTaskBody.parse(body);
    return assignTask(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(taskId),
      {
        membership_id: input.membership_id,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.complete')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/tasks/:taskId/start')
  async startTask(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = taskCommandBody.parse(body);
    return startTask(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(taskId),
      { version: input.version, idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RequirePermission('task.complete')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/tasks/:taskId/complete')
  async completeTask(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = taskCommandBody.parse(body);
    return completeTask(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(taskId),
      {
        version: input.version,
        note: input.note ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.inspect')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/tasks/:taskId/inspect')
  async inspectTask(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = taskCommandBody.parse(body);
    return inspectTask(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(taskId),
      {
        version: input.version,
        note: input.note ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/dnd-logs')
  async listDndLogs(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listDndQuery.parse(query);
    return listDndLogs(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        resource_id: input.resource_id ?? null,
        state: input.state ?? null,
        limit: input.limit,
        cursor: input.cursor ?? null,
      },
    );
  }

  @RequirePermission('task.manage')
  @Post(':tenantId/properties/:propertyId/dnd-logs')
  async logDnd(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = logDndBody.parse(body);
    return logDnd(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        resource_id: input.resource_id,
        item_id: input.item_id ?? null,
        note: input.note,
        follow_up_at: input.follow_up_at ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.complete')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/dnd-logs/:dndId/follow-up')
  async followUpDnd(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('dndId') dndId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = followUpDndBody.parse(body);
    return followUpDnd(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(dndId),
      { note: input.note, idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/operations-policy')
  async getOperationsPolicy(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return getOperationsPolicy(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('task.manage')
  @HttpCode(200)
  @Put(':tenantId/properties/:propertyId/operations-policy')
  async setOperationsPolicy(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = setOperationsPolicyBody.parse(body);
    return setOperationsPolicy(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        inspection_required: input.inspection_required,
        long_stay_clean_interval_days:
          input.long_stay_clean_interval_days ?? null,
        version: input.version ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('maintenance.read')
  @Get(':tenantId/properties/:propertyId/work-orders')
  async listWorkOrders(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listWorkOrdersQuery.parse(query);
    return listWorkOrders(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        status: input.status ?? null,
        resource_id: input.resource_id ?? null,
        assignee_membership_id: input.assignee_membership_id ?? null,
        limit: input.limit,
        cursor: input.cursor ?? null,
      },
    );
  }

  @RequirePermission('maintenance.manage')
  @Post(':tenantId/properties/:propertyId/work-orders')
  async createWorkOrder(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = createWorkOrderBody.parse(body);
    return createWorkOrder(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        resource_id: input.resource_id,
        category: input.category,
        severity: input.severity,
        impact: input.impact,
        emergency: input.emergency ?? false,
        description: input.description,
        period: input.period ?? null,
        assignee_membership_id: input.assignee_membership_id ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('maintenance.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/work-orders/:workOrderId/assign')
  async assignWorkOrder(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') workOrderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = assignWorkOrderBody.parse(body);
    return assignWorkOrder(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(workOrderId),
      {
        membership_id: input.membership_id,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('maintenance.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/work-orders/:workOrderId/transitions')
  async transitionWorkOrder(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') workOrderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = transitionWorkOrderBody.parse(body);
    return transitionWorkOrder(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(workOrderId),
      {
        status: input.status,
        version: input.version,
        note: input.note ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('maintenance.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/work-orders/:workOrderId/close')
  async closeWorkOrder(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') workOrderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = closeWorkOrderBody.parse(body);
    return closeWorkOrder(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(workOrderId),
      {
        version: input.version,
        note: input.note ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('maintenance.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/work-orders/:workOrderId/reopen')
  async reopenWorkOrder(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') workOrderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = reopenWorkOrderBody.parse(body);
    return reopenWorkOrder(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(workOrderId),
      {
        reason: input.reason,
        version: input.version,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/operations/board')
  async getOperationsBoard(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return getOperationsBoard(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/shift-handovers')
  async listShiftHandovers(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listLimitQuery.parse(query);
    return listShiftHandovers(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { limit: input.limit },
    );
  }

  @RequirePermission('task.manage')
  @Post(':tenantId/properties/:propertyId/shift-handovers')
  async createShiftHandover(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = createShiftHandoverBody.parse(body);
    return createShiftHandover(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        shift_date: input.shift_date ?? null,
        to_membership_id: input.to_membership_id ?? null,
        follow_up_membership_id: input.follow_up_membership_id ?? null,
        cashier_session_id: input.cashier_session_id ?? null,
        exceptions_text: input.exceptions_text ?? null,
        note: input.note ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('task.read')
  @Get(':tenantId/properties/:propertyId/notifications')
  async listNotifications(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = listLimitQuery.parse(query);
    return listNotifications(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { limit: input.limit },
    );
  }

  @RequirePermission('task.read')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/notifications/:notificationId/read')
  async markNotificationRead(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('notificationId') notificationId: string,
  ) {
    return markNotificationRead(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(notificationId),
    );
  }
}
