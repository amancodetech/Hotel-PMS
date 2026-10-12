import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  getNightAuditOverview,
  listNightAuditRuns,
  resolveNightAuditException,
  retryNightAudit,
  startNightAudit,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import {
  listRunsQuery,
  nightAuditOverviewQuery,
  resolveExceptionBody,
  retryNightAuditBody,
  startNightAuditBody,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1/tenants')
export class NightAuditController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/night-audits')
  async getNightAuditOverview(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const input = nightAuditOverviewQuery.parse(query);
    return getNightAuditOverview(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input.date ?? null,
    );
  }

  @RequirePermission('folio.read')
  @Get(':tenantId/properties/:propertyId/night-audits/runs')
  async listNightAuditRuns(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    listRunsQuery.parse(query);
    return listNightAuditRuns(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('business_day.close')
  @HttpCode(202)
  @Post(':tenantId/properties/:propertyId/night-audits/runs')
  async startNightAudit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = startNightAuditBody.parse(body);
    return startNightAudit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        business_date: input.business_date,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('business_day.close')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/night-audits/runs/:runId/retry')
  async retryNightAudit(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('runId') runId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    retryNightAuditBody.parse(body ?? {});
    return retryNightAudit(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(runId),
      { idempotencyKey: idempotencyKey ?? null },
    );
  }

  @RequirePermission('business_day.close')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/night-audits/exceptions/:exceptionId/resolution',
  )
  async resolveNightAuditException(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('exceptionId') exceptionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = resolveExceptionBody.parse(body);
    return resolveNightAuditException(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(exceptionId),
      {
        owner_membership_id: input.owner_membership_id ?? null,
        owner_label: input.owner_label ?? null,
        reason: input.reason,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }
}
