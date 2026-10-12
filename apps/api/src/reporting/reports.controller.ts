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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  captureReportSnapshot,
  createReportExport,
  downloadReportExport,
  listReportExports,
  listReportSnapshots,
  readReport,
  readTenantReport,
  revokeReportExport,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from '../property/property.controller.js';
import {
  captureSnapshotBody,
  exportReportBody,
  exportTenantReportBody,
  listExportsQuery,
  readReportBody,
  readTenantReportBody,
} from './dto.js';

const uuid = z.string().uuid();

@Controller('api/v1/tenants')
export class ReportsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('report.operational.view')
  @HttpCode(200)
  @Post(':tenantId/reports/query')
  async readTenantReport(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const input = readTenantReportBody.parse(body);
    return readTenantReport(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(tenantId),
      {
        kind: input.kind,
        period: input.period,
        currency: input.currency,
        property_ids: input.property_ids ?? null,
      },
    );
  }

  @RequirePermission('report.operational.view')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reports/query')
  async readReport(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = readReportBody.parse(body);
    return readReport(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input,
    );
  }

  @RequirePermission('report.export')
  @HttpCode(202)
  @Post(':tenantId/properties/:propertyId/reports/exports')
  async exportReport(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = exportReportBody.parse(body);
    return createReportExport(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        kind: input.kind,
        period: input.period,
        currency: input.currency ?? null,
        resource_type: input.resource_type ?? null,
        reference_date: input.reference_date ?? null,
        format: 'CSV',
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('report.export')
  @HttpCode(202)
  @Post(':tenantId/reports/exports')
  async exportTenantReport(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = exportTenantReportBody.parse(body);
    return createReportExport(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      null,
      {
        kind: input.kind,
        period: input.period,
        currency: input.currency,
        format: 'CSV',
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('report.export')
  @Get(':tenantId/reports/exports')
  async listExports(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Query() query: unknown,
  ) {
    const input = listExportsQuery.parse(query);
    const items = await listReportExports(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      input.property_id ?? null,
    );
    return { items };
  }

  @RequirePermission('report.export')
  @Get(':tenantId/reports/exports/:exportId/download')
  async downloadExport(
    @Req() request: AuthedRequest,
    @Res() response: Response,
    @Param('tenantId') tenantId: string,
    @Param('exportId') exportId: string,
  ) {
    const file = await downloadReportExport(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(exportId),
    );
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader(
      'content-disposition',
      `attachment; filename="${file.file_name}"`,
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-report-sha256', file.content_sha256);
    response.send(file.content);
  }

  @RequirePermission('report.export')
  @HttpCode(200)
  @Post(':tenantId/reports/exports/:exportId/revocation')
  async revokeExport(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('exportId') exportId: string,
  ) {
    return {
      export: await revokeReportExport(
        this.runtime.orm,
        serviceContext(request, uuid.parse(tenantId)),
        uuid.parse(exportId),
      ),
    };
  }

  @RequirePermission('report.operational.view')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/reports/snapshots')
  async captureReportSnapshot(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = captureSnapshotBody.parse(body);
    return captureReportSnapshot(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        reference_date: input.reference_date ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
  }

  @RequirePermission('report.operational.view')
  @Get(':tenantId/properties/:propertyId/reports/snapshots')
  async listSnapshots(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const items = await listReportSnapshots(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items };
  }
}
