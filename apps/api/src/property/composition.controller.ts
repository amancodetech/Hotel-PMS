import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  activateCompositionById,
  applyCompositionChange,
  createComposition,
  previewCompositionChange,
  readCompositionDetail,
  readCompositions,
} from '@hotel/backend';
import type {
  CompositionChangeImpact,
  CompositionEdgeRow,
  CompositionLeafRow,
  CompositionVersionRow,
} from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import {
  compositionDto,
  compositionEdgeDto,
  compositionLeafDto,
  compositionLeafViewDto,
  resourceAllocationDto,
  resourceBlockDto,
} from './dto.js';
import { serviceContext } from './property.controller.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const compositionBody = z
  .object({
    product_id: uuid,
    effective_period: z
      .object({ arrival: isoDate, departure: isoDate })
      .strict(),
    resource_ids: z.array(uuid).max(32),
    nested_version_ids: z.array(uuid).max(32),
  })
  .strict()
  .refine(
    (value) => value.resource_ids.length + value.nested_version_ids.length > 0,
    'at least one resource or nested version is required',
  );
const activateBody = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();
const changeBody = z
  .object({
    effective_from: isoDate,
    effective_to: isoDate.nullable().optional(),
    resource_ids: z.array(uuid).min(1).max(32),
  })
  .strict();
const changeApplyBody = changeBody
  .extend({ preview_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

function changeInput(input: z.infer<typeof changeBody>) {
  return {
    effectiveFrom: input.effective_from,
    effectiveTo: input.effective_to ?? null,
    resourceIds: input.resource_ids,
  };
}

function impactDto(plan: CompositionChangeImpact) {
  return {
    verdict: plan.verdict,
    fingerprint: plan.fingerprint,
    product_id: plan.product_id,
    product_code: plan.product_code,
    composition_id: plan.composition_id,
    current: {
      composition: compositionDto(plan.current.composition),
      leaves: plan.current.leaves.map(compositionLeafViewDto),
    },
    proposed: {
      effective_from: plan.proposed.effective_from,
      effective_to: plan.proposed.effective_to,
      leaves: plan.proposed.leaves.map(compositionLeafViewDto),
    },
    conflicts: plan.conflicts.map(resourceAllocationDto),
    retained_commitments: plan.retained_commitments.map(resourceAllocationDto),
    removed_leaves: plan.removed_leaves.map(compositionLeafViewDto),
    intersecting_blocks: plan.intersecting_blocks.map(resourceBlockDto),
  };
}

function compositionDetail(result: {
  composition: CompositionVersionRow;
  edges: CompositionEdgeRow[];
  leaves: CompositionLeafRow[];
}) {
  return {
    composition: compositionDto(result.composition),
    edges: result.edges.map(compositionEdgeDto),
    leaves: result.leaves.map(compositionLeafDto),
  };
}

@Controller('api/v1/tenants')
export class CompositionsController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/compositions')
  async listCompositions(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const versions = await readCompositions(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { items: versions.map(compositionDto) };
  }

  @RequirePermission('composition.manage')
  @Post(':tenantId/properties/:propertyId/compositions')
  async createComposition(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    const input = compositionBody.parse(body);
    const version = await createComposition(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        productId: uuid.parse(input.product_id),
        effectiveFrom: input.effective_period.arrival,
        effectiveTo: input.effective_period.departure,
        resourceIds: input.resource_ids,
        nestedVersionIds: input.nested_version_ids,
      },
    );
    return { composition: compositionDto(version) };
  }

  @RequirePermission('composition.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/compositions/:compositionId/activate')
  async activateComposition(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('compositionId') compositionId: string,
    @Body() body: unknown,
  ) {
    const input = activateBody.parse(body);
    const result = await activateCompositionById(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(compositionId),
      input.reason,
    );
    return compositionDetail(result);
  }

  @RequirePermission('property.read')
  @HttpCode(200)
  @Post(
    ':tenantId/properties/:propertyId/compositions/:compositionId/change-previews',
  )
  async previewCompositionChange(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('compositionId') compositionId: string,
    @Body() body: unknown,
  ) {
    const input = changeBody.parse(body);
    const plan = await previewCompositionChange(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(compositionId),
      changeInput(input),
    );
    return impactDto(plan);
  }

  @RequirePermission('composition.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/compositions/:compositionId/changes')
  async applyCompositionChange(
    @Req() request: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('compositionId') compositionId: string,
    @Body() body: unknown,
  ) {
    const input = changeApplyBody.parse(body);
    const result = await applyCompositionChange(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(compositionId),
      {
        ...changeInput(input),
        previewFingerprint: input.preview_fingerprint,
        idempotencyKey: idempotencyKey ?? null,
      },
    );
    return {
      composition: compositionDto(result.composition),
      superseded: compositionDto(result.superseded),
      fingerprint: result.fingerprint,
      replayed: result.replayed ?? false,
    };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/compositions/:compositionId')
  async getComposition(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('compositionId') compositionId: string,
  ) {
    const result = await readCompositionDetail(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(compositionId),
    );
    return compositionDetail(result);
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/compositions/:compositionId/leaves')
  async listLeaves(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Param('compositionId') compositionId: string,
  ) {
    const result = await readCompositionDetail(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      uuid.parse(compositionId),
    );
    return { items: result.leaves.map(compositionLeafDto) };
  }
}
