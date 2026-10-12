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
  applySetupMigration,
  previewSetupMigration,
  readSetupChanges,
  readSetupReconciliation,
  readSetupSettings,
} from '@hotel/backend';
import type {
  CompositionWindowRow,
  MigrationPreview,
  MigrationResult,
  SetupChangeEventRow,
  SetupReconciliationResult,
  SetupSettingsResult,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from './property.controller.js';
import {
  compositionDto,
  compositionLeafViewDto,
  compositionSummaryDto,
  compositionWindowDto,
  coverageGapDto,
  migrationCountsDto,
  resourceAllocationDto,
  resourceBlockDto,
  setupChangeEventDto,
  sharedResourceDto,
} from './dto.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const changesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(3).max(200).optional(),
  })
  .strict();

const migrationBody = z
  .object({
    product_id: uuid,
    effective_from: isoDate,
    effective_to: isoDate.nullable().optional(),
    resource_ids: z.array(uuid).min(1).max(32),
  })
  .strict();
const migrationApplyBody = migrationBody
  .extend({ preview_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

function migrationInput(input: z.infer<typeof migrationBody>) {
  return {
    productId: input.product_id,
    effectiveFrom: input.effective_from,
    effectiveTo: input.effective_to ?? null,
    resourceIds: input.resource_ids,
  };
}

function migrationPreviewDto(plan: MigrationPreview) {
  return {
    verdict: plan.verdict,
    fingerprint: plan.fingerprint,
    product_id: plan.product_id,
    product_code: plan.product_code,
    effective_from: plan.effective_from,
    effective_to: plan.effective_to,
    leaves: plan.leaves.map(compositionLeafViewDto),
    conflicts: plan.conflicts.map(resourceAllocationDto),
    intersecting_blocks: plan.intersecting_blocks.map(resourceBlockDto),
    before: migrationCountsDto(plan.before),
    after: migrationCountsDto(plan.after),
  };
}

function migrationResultDto(result: MigrationResult) {
  return {
    composition: compositionDto(result.composition),
    reconciliation: {
      before: migrationCountsDto(result.reconciliation.before),
      after: migrationCountsDto(result.reconciliation.after),
      resource_ids_preserved: result.reconciliation.resource_ids_preserved,
      resource_ids: result.reconciliation.resource_ids,
    },
    fingerprint: result.fingerprint,
    replayed: result.replayed ?? false,
  };
}

function changeEventDto(row: SetupChangeEventRow) {
  return setupChangeEventDto(row);
}

function scheduledDto(rows: CompositionWindowRow[]) {
  return rows.map(compositionWindowDto);
}

function settingsDto(result: SetupSettingsResult) {
  return {
    property: result.property,
    setup: result.setup,
    counts: result.counts,
    scheduled_changes: scheduledDto(result.scheduled_changes),
    recent_changes: result.recent_changes.map(changeEventDto),
  };
}

function reconciliationDto(result: SetupReconciliationResult) {
  return {
    generated_at: result.generated_at,
    counts: result.counts,
    products: result.products.map(compositionSummaryDto),
    checks: result.checks.map((check) => {
      if (check.code === 'SHARED_RESOURCE')
        return {
          code: check.code,
          status: check.status,
          details: check.details.map(sharedResourceDto),
        };
      if (check.code === 'COMMITMENT_COVERAGE')
        return {
          code: check.code,
          status: check.status,
          details: check.details.map(coverageGapDto),
        };
      return {
        code: check.code,
        status: check.status,
        details: check.details,
      };
    }),
  };
}

@Controller('api/v1/tenants')
export class SetupInsightsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-settings')
  async settings(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const result = await readSetupSettings(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return settingsDto(result);
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-changes')
  async changes(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const parsed = changesQuery.parse(query);
    const page = await readSetupChanges(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { limit: parsed.limit, cursor: parsed.cursor ?? null },
    );
    return {
      items: page.items.map(changeEventDto),
      next_cursor: page.next_cursor,
    };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-reconciliation')
  async reconciliation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const result = await readSetupReconciliation(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return reconciliationDto(result);
  }

  @RequirePermission('property.read')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-migration-previews')
  async previewMigration(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = migrationBody.parse(body);
    const plan = await previewSetupMigration(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      migrationInput(input),
    );
    return migrationPreviewDto(plan);
  }

  @RequirePermission('composition.manage')
  @Post(':tenantId/properties/:propertyId/setup-migrations')
  async applyMigration(
    @Req() request: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = migrationApplyBody.parse(body);
    const result = await applySetupMigration(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        ...migrationInput(input),
        previewFingerprint: input.preview_fingerprint,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
    return migrationResultDto(result);
  }
}
