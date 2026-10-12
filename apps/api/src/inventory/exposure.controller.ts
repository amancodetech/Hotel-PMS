import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  getSyncStatus,
  listExposuresForProperty,
  previewExposure,
  publishExposure,
  reconcileConnection,
  setDistributionSaleStatus,
  withdrawExposure,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { requestCorrelation } from '../identity/http.js';
import { serviceContext } from '../property/property.controller.js';
import { exposureDto } from './dto.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.object({ arrival: isoDate, departure: isoDate }).strict();

const previewBody = z
  .object({
    connection_id: uuid,
    product_id: uuid,
    period,
    resource_ids: z.array(uuid).min(1).max(32),
    inventory_version: z.number().int().min(1),
  })
  .strict();

const publishBody = z
  .object({
    preview_id: uuid,
    preview_version: z.number().int().min(1),
    approval_id: uuid.nullable().optional(),
  })
  .strict();

const withdrawBody = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

const saleBody = z.union([
  z
    .object({
      action: z.literal('STOP_SELL'),
      product_id: uuid,
      period,
      reason: z.string().trim().min(1).max(1000),
      approval_id: uuid.nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('OPEN'),
      restriction_id: uuid,
      reason: z.string().trim().min(1).max(1000),
      approval_id: uuid.nullable().optional(),
    })
    .strict(),
]);

const syncQuery = z
  .object({ attempts: z.enum(['true', 'false']).optional() })
  .strict();

@Controller('api/v1/tenants')
export class ExposuresController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('channel.sale.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/exposures/preview')
  async preview(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = previewBody.parse(body);
    const result = await previewExposure(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        connectionId: input.connection_id,
        productId: input.product_id,
        period: input.period,
        resourceIds: input.resource_ids,
        inventoryVersion: input.inventory_version,
      },
    );
    return {
      preview_id: result.previewId,
      inventory_version: result.inventoryVersion,
      expires_at: result.expiresAt,
      allowed: result.allowed,
      reason_codes: result.reasonCodes,
      preview_version: result.previewVersion,
    };
  }

  @RequirePermission('channel.sale.manage')
  @HttpCode(202)
  @Post(':tenantId/properties/:propertyId/exposures')
  async publish(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = publishBody.parse(body);
    const exposure = await publishExposure(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        previewId: input.preview_id,
        previewVersion: input.preview_version,
        approvalId: input.approval_id ?? null,
      },
    );
    return {
      operation_id: exposure.id,
      resource_id: exposure.id,
      version: exposure.version,
      state: exposure.state,
      correlation_id: requestCorrelation(request),
    };
  }

  @RequirePermission('channel.sale.manage')
  @HttpCode(202)
  @Post(':tenantId/properties/:propertyId/exposures/:exposureId/withdraw')
  async withdraw(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('exposureId') exposureId: string,
    @Body() body: unknown,
  ) {
    const input = withdrawBody.parse(body);
    const exposure = await withdrawExposure(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(exposureId),
      input.reason,
    );
    return {
      operation_id: exposure.id,
      resource_id: exposure.id,
      version: exposure.version,
      state: exposure.state,
      correlation_id: requestCorrelation(request),
    };
  }

  @RequirePermission('channel.read')
  @Get(':tenantId/properties/:propertyId/exposures')
  async list(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query('connectionId') connectionId?: string,
  ) {
    const exposures = await listExposuresForProperty(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      connectionId ? uuid.parse(connectionId) : undefined,
    );
    return { items: exposures.map(exposureDto) };
  }

  @RequirePermission('channel.sale.manage')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/connections/:connectionId/sale-status',
  )
  async saleStatus(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    const input = saleBody.parse(body);
    const result =
      input.action === 'STOP_SELL'
        ? await setDistributionSaleStatus(
            this.runtime.orm,
            serviceContext(request, uuid.parse(tenantId)),
            uuid.parse(propertyId),
            uuid.parse(connectionId),
            {
              action: 'STOP_SELL',
              productId: input.product_id,
              period: input.period,
              reason: input.reason,
            },
          )
        : await setDistributionSaleStatus(
            this.runtime.orm,
            serviceContext(request, uuid.parse(tenantId)),
            uuid.parse(propertyId),
            uuid.parse(connectionId),
            {
              action: 'OPEN',
              restrictionId: input.restriction_id,
              reason: input.reason,
            },
          );
    return {
      operation_id: result.operationId,
      resource_id: result.resourceId,
      version: result.version,
      effective_open: result.effectiveOpen,
      reason_codes: result.reasonCodes,
      sync_state: result.syncState,
    };
  }

  @RequirePermission('channel.read')
  @Get(':tenantId/properties/:propertyId/connections/:connectionId/sync')
  async sync(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
    @Query() query: unknown,
  ) {
    const { attempts } = syncQuery.parse(query);
    const result = await getSyncStatus(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(connectionId),
      attempts === 'true',
    );
    return {
      connection_id: result.connectionId,
      desired_version: result.desiredVersion,
      provider_accepted_version: result.providerAcceptedVersion,
      channel_verified_version: result.channelVerifiedVersion,
      state: result.state,
      observed_at: result.observedAt,
      pending: result.pending,
      failed: result.failed,
      unknown: result.unknown,
      partial: result.partial,
      attempts: result.attempts.map((attempt) => ({
        id: attempt.id,
        event_type: attempt.event_type,
        status: attempt.status,
        attempt_count: attempt.attempt_count,
        certainty: attempt.certainty,
        last_safe_error_code: attempt.last_safe_error_code,
        updated_at: attempt.updated_at,
      })),
    };
  }

  @RequirePermission('channel.reconcile')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/connections/:connectionId/reconcile')
  async reconcile(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    const input = withdrawBody.parse(body);
    const result = await reconcileConnection(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(connectionId),
      input.reason,
    );
    return {
      activated: result.activated,
      released: result.released,
      reconciling: result.reconciling,
    };
  }
}
